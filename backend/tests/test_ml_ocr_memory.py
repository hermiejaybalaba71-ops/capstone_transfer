import sys
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml import cache as ocr_cache, pipeline, preproc


class OcrMemorySafetyTests(unittest.TestCase):
    def test_cache_ignores_results_from_before_digit_box_ocr(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = Path(temp_dir) / "ocr_cache.json"
            cache_path.write_text(
                json.dumps(
                    {
                        "_v": 8,
                        "outdated": {
                            "ocr_value": 800_000,
                            "anchor": "If Taxable Income is:",
                        },
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(ocr_cache, "CACHE_PATH", cache_path):
                self.assertEqual(ocr_cache.load(), {})

    def test_decode_bounds_ocr_dimensions_and_preserves_source_dimensions(self):
        source = Image.new("RGB", (3000, 3600), "white")
        encoded = BytesIO()
        source.save(encoded, format="PNG")

        rgb, metadata = preproc.decode(encoded.getvalue())

        self.assertLessEqual(max(rgb.shape[:2]), preproc.MAX_OCR_SIDE)
        self.assertEqual(metadata["size"], [3000, 3600])
        self.assertEqual(
            metadata["ocr_size"],
            [rgb.shape[1], rgb.shape[0]],
        )

    def test_candidate_generation_is_lazy_after_original_image(self):
        rgb = np.zeros((64, 64, 3), dtype=np.uint8)

        with patch("ml.preproc.upscale", wraps=preproc.upscale) as upscale:
            candidates = preproc.build_candidates(rgb)
            first = next(candidates)

            self.assertEqual(first["name"], "original")
            self.assertIs(first["array"], rgb)
            upscale.assert_not_called()
            candidates.close()

    def test_candidate_generation_preserves_the_configured_variant_limit(self):
        rgb = np.zeros((8, 8, 3), dtype=np.uint8)
        gray = np.zeros((8, 8), dtype=np.uint8)

        with (
            patch("ml.preproc._config.OCR_MAX_VARIANTS", 2),
            patch("ml.preproc.upscale", return_value=rgb),
            patch("ml.preproc.to_gray", return_value=gray),
            patch("ml.preproc.normalize", return_value=gray),
            patch("ml.preproc._to_rgb", side_effect=lambda image: np.repeat(image[:, :, None], 3, axis=2)),
            patch("ml.preproc.otsu", return_value=gray),
            patch("ml.preproc.deskew", return_value=(gray, 2.0)) as deskew,
        ):
            candidates = list(preproc.build_candidates(rgb))

        self.assertEqual(
            [candidate["name"] for candidate in candidates],
            ["original", "grayscale+contrast", "grayscale+otsu"],
        )
        deskew.assert_not_called()

    def test_zero_variant_limit_skips_preprocessing_after_original(self):
        rgb = np.zeros((1800, 2400, 3), dtype=np.uint8)

        with (
            patch("ml.preproc._config.OCR_MAX_VARIANTS", 0),
            patch("ml.preproc.upscale", wraps=preproc.upscale) as upscale,
        ):
            candidates = list(preproc.build_candidates(rgb))

        self.assertEqual([candidate["name"] for candidate in candidates], ["original"])
        self.assertIs(candidates[0]["array"], rgb)
        upscale.assert_not_called()

    def test_income_fallback_uses_the_last_candidate_without_extra_ocr(self):
        first = {"name": "original", "array": np.zeros((600, 600, 3), dtype=np.uint8), "steps": ["decode"]}
        last = {"name": "grayscale+otsu", "array": np.ones((600, 600, 3), dtype=np.uint8), "steps": ["otsu"]}

        class FakeEngine:
            def __init__(self):
                self.allow_fallback_values = []
                self.scan_count = 0

            def scan(self, image, box_thresh, allow_fallback):
                self.allow_fallback_values.append(allow_fallback)
                self.scan_count += 1
                return {
                    "lines": [{"text": str(self.scan_count), "score": 0.9, "y": 1, "x": 1, "h": 1}],
                    "extracted": None,
                    "line_count": 1,
                    "avg_confidence": 0.9,
                    "ocr_ms": 1.0,
                }

        fake_engine = FakeEngine()
        fallback = {
            "value": 132_000,
            "method": "largest_currency_amount",
            "low_confidence": True,
            "confidence": 0.9,
            "anchor": "",
            "amount_line": "132,000",
        }

        with (
            patch("ml.pipeline.storage.download", return_value=b"x" * 20_000),
            patch("ml.pipeline.preproc.decode", return_value=(np.zeros((600, 600, 3), dtype=np.uint8), {})),
            patch("ml.pipeline.preproc.image_stats", return_value={}),
            patch(
                "ml.pipeline.preproc.build_candidates",
                return_value=(candidate for candidate in [first, last]),
            ),
            patch("ml.pipeline.ocr_engine.peek", return_value=None),
            patch("ml.pipeline.ocr_engine.shared", return_value=fake_engine),
            patch("ml.pipeline.ocr_engine.extract_income", return_value=fallback) as extract_income,
        ):
            result = pipeline._scan_one(
                {
                    "path": "test/itr.png",
                    "application_id": 1,
                    "student_name": "Test applicant",
                    "declared_income": 132_000,
                    "linked": True,
                }
            )

        self.assertEqual(result["ocr_value"], 132_000)
        self.assertEqual(result["variant"], "grayscale+otsu")
        self.assertTrue(result["low_confidence"])
        self.assertEqual(fake_engine.scan_count, 3)
        self.assertEqual(fake_engine.allow_fallback_values, [False, False, False])
        extract_income.assert_called_once_with(
            [{"text": "3", "score": 0.9, "y": 1, "x": 1, "h": 1}],
            allow_fallback=True,
        )

    def test_page_two_uses_targeted_1701_ms_digits_after_full_page_misses(self):
        image = np.zeros((600, 600, 3), dtype=np.uint8)
        lines = [
            {"text": "1701-MS 08/24 P2", "score": 0.9, "y": 100, "x": 10, "h": 10},
            {"text": "1 Gross Compensation Income", "score": 0.9, "y": 200, "x": 10, "h": 10},
        ]
        extraction = {
            "value": 180_500,
            "method": "1701_ms_compensation_digit_boxes",
            "anchor": "1 Gross Compensation Income",
            "amount_line": "180,500",
            "confidence": 0.9,
        }

        class FakeEngine:
            engine_info = {}
            load_ms = 0.0

            def __init__(self):
                self.scan_count = 0
                self.cell_read_count = 0

            def scan(self, _image, box_thresh, allow_fallback):
                self.scan_count += 1
                self.assert_no_fallback = allow_fallback
                return {
                    "lines": lines,
                    "extracted": None,
                    "line_count": len(lines),
                    "avg_confidence": 0.9,
                    "ocr_ms": 1.0,
                }

            def extract_1701_ms_compensation_income(self, _image, _lines):
                self.cell_read_count += 1
                return extraction

        engine = FakeEngine()
        record = {"attempts": 0, "ocr_ms": 0.0}
        candidate = {"name": "original", "array": image, "steps": ["decode"]}

        with (
            patch("ml.pipeline.storage.download", return_value=b"x" * 20_000),
            patch("ml.pipeline.preproc.decode", return_value=(image, {})),
            patch("ml.pipeline.preproc.image_stats", return_value={}),
            patch(
                "ml.pipeline.preproc.build_candidates",
                return_value=(item for item in [candidate]),
            ),
            patch("ml.pipeline.ocr_engine.peek", return_value=engine),
            patch("ml.pipeline.ocr_engine.shared", return_value=engine),
            patch("ml.pipeline.log"),
        ):
            status, detail = pipeline._ocr_page("test/page2.png", record, page_no=2)

        self.assertEqual((status, detail), ("found", None))
        self.assertEqual(record["ocr_value"], 180_500)
        self.assertEqual(record["method"], "1701_ms_compensation_digit_boxes")
        self.assertEqual(record["amount_line"], "180,500")
        self.assertEqual(engine.scan_count, 2)
        self.assertEqual(engine.cell_read_count, 1)

    def test_1701_ms_taxable_compensation_is_not_a_gross_income_substitute(self):
        image = np.zeros((600, 600, 3), dtype=np.uint8)
        lines = [
            {"text": "1701-MS 08/24 P2", "score": 0.9, "y": 100, "x": 10, "h": 10},
            {"text": "3 Taxable Compensation Income", "score": 0.9, "y": 200, "x": 10, "h": 10},
        ]
        other_income = {
            "value": 158_800,
            "method": "taxable_compensation_income",
            "anchor": "3 Taxable Compensation Income",
            "amount_line": "158800",
            "confidence": 0.9,
        }

        class FakeEngine:
            engine_info = {}
            load_ms = 0.0

            def scan(self, _image, box_thresh, allow_fallback):
                return {
                    "lines": lines,
                    "extracted": other_income,
                    "line_count": len(lines),
                    "avg_confidence": 0.9,
                    "ocr_ms": 1.0,
                }

            def extract_1701_ms_compensation_income(self, _image, _lines):
                return None

        engine = FakeEngine()
        candidate = {"name": "original", "array": image, "steps": ["decode"]}
        record = {"attempts": 0, "ocr_ms": 0.0, "ocr_value": None, "itr_fields": []}

        with (
            patch("ml.pipeline.storage.download", return_value=b"x" * 20_000),
            patch("ml.pipeline.preproc.decode", return_value=(image, {})),
            patch("ml.pipeline.preproc.image_stats", return_value={}),
            patch("ml.pipeline.preproc.build_candidates", return_value=(item for item in [candidate])),
            patch("ml.pipeline.ocr_engine.peek", return_value=engine),
            patch("ml.pipeline.ocr_engine.shared", return_value=engine),
            patch("ml.pipeline.ocr_engine.extract_income", return_value=None) as fallback,
            patch("ml.pipeline.log"),
        ):
            status, detail = pipeline._ocr_page("test/page2.png", record, page_no=2)

        self.assertEqual(status, "no_income", detail)
        self.assertIsNone(record["ocr_value"])
        fallback.assert_called_once_with(lines, allow_fallback=False)


class TwoPageItrScanTests(unittest.TestCase):
    """BIR 1701-MS is two pages: Page 1 has no income row, Page 2 does."""

    DOC = {
        "path": "student/itr.png",
        "path2": "student/itr_p2.png",
        "application_id": 1,
        "student_name": "Test applicant",
        "declared_income": 300_500,
        "linked": True,
    }

    @staticmethod
    def _doc(**overrides):
        doc = dict(TwoPageItrScanTests.DOC)
        doc.update(overrides)
        return doc

    def test_page_two_is_scanned_when_page_one_has_no_income(self):
        calls = []

        def fake_page(path, record, page_no):
            calls.append((path, page_no))
            if page_no == 2:
                record["ocr_value"] = 300_500
                record["method"] = "gross_compensation_income"
                record["low_confidence"] = False
                record["income_confidence"] = 0.97
                return "found", None
            return "no_income", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(self._doc())

        self.assertEqual(calls, [("student/itr.png", 1), ("student/itr_p2.png", 2)])
        self.assertEqual(result["ocr_value"], 300_500)
        self.assertEqual(result["income_page"], 2)
        self.assertIsNone(result["error"])
        self.assertFalse(result["scan_failure"])
        self.assertTrue(result["match"]["exact_match"])

    def test_page_one_fallback_amount_defers_to_the_labelled_page_two_figure(self):
        def fake_page(path, record, page_no):
            if page_no == 1:
                # Page 1 only offers the generic "largest amount" guess.
                record["ocr_value"] = 38_600
                record["method"] = "largest_currency_amount"
                record["low_confidence"] = True
                return "found", None
            record["ocr_value"] = 300_500
            record["method"] = "gross_compensation_income"
            record["low_confidence"] = False
            return "found", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(self._doc())

        self.assertEqual(result["ocr_value"], 300_500)
        self.assertEqual(result["income_page"], 2)
        self.assertFalse(result["low_confidence"])

    def test_page_one_fallback_is_kept_when_page_two_yields_nothing(self):
        def fake_page(path, record, page_no):
            if page_no == 1:
                record["ocr_value"] = 38_600
                record["method"] = "largest_currency_amount"
                record["low_confidence"] = True
                return "found", None
            return "no_income", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(self._doc())

        self.assertEqual(result["ocr_value"], 38_600)
        self.assertEqual(result["income_page"], 1)
        self.assertTrue(result["low_confidence"])

    def test_scans_page_two_after_a_page_one_income_candidate(self):
        calls = []

        def fake_page(path, record, page_no):
            calls.append(page_no)
            if page_no == 1:
                record["ocr_value"] = 13_200
                record["method"] = "page_one_candidate"
                record["low_confidence"] = False
                record["itr_fields"].append(
                    {"field": "total_amount_payable", "page": 1, "kind": "tax", "value": 13_200}
                )
                return "found", None
            record["ocr_value"] = 300_500
            record["method"] = "gross_compensation_income"
            record["low_confidence"] = False
            record["itr_fields"].append(
                {"field": "gross_compensation_income", "page": 2, "kind": "income", "value": 300_500}
            )
            return "found", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(self._doc())

        self.assertEqual(calls, [1, 2])
        self.assertEqual(result["ocr_value"], 300_500)
        self.assertEqual(result["income_page"], 2)
        self.assertEqual(
            [field["field"] for field in result["itr_fields"]],
            ["total_amount_payable", "gross_compensation_income"],
        )

    def test_single_page_documents_still_scan_exactly_one_page(self):
        calls = []

        def fake_page(path, record, page_no):
            calls.append(page_no)
            return "no_income", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(self._doc(path2=None))

        self.assertEqual(calls, [1])
        self.assertEqual(
            result["error"],
            "OCR not cleared: none of the three priority rows carried a value "
            "on the uploaded ITR page(s)",
        )
        self.assertFalse(result["ocr_cleared"])
        self.assertIsNone(result["income_page"])

    def test_page_two_only_documents_are_scanned_as_page_two(self):
        calls = []

        def fake_page(path, record, page_no):
            calls.append((path, page_no))
            record["ocr_value"] = 300_500
            record["low_confidence"] = False
            return "found", None

        with patch.object(pipeline, "_ocr_page", side_effect=fake_page):
            result = pipeline._scan_one(
                self._doc(path="student/itr_p2.png", path2=None, page_no=2)
            )

        self.assertEqual(calls, [("student/itr_p2.png", 2)])
        self.assertEqual(result["income_page"], 2)


if __name__ == "__main__":
    unittest.main()
