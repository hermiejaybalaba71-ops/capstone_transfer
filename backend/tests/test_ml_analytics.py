import sys
import math
import tempfile
import unittest
from io import BytesIO
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from openpyxl import Workbook
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import joblib

from ml import features, pipeline
from ml.csv_data import _resolve, load_training_csv, row_from
from ml.ocr_engine import (
    _layout_anchor,
    extract_1701_ms_compensation_income,
    extract_1701_ms_fields,
    extract_1701_ms_layout_fields,
    extract_income,
    match_declared,
    pick_priority_value,
)
from ml import form_layout
from ml.pipeline import analytics_from, build_docs, index_by_application
from ml.pipeline import _cache_id as pipeline_cache_id
from ml.rank_model import load_external, predict, train
from ml.service import MAX_SHEET_BYTES, _parse_sheet, _stream_pipeline, health


class OcrIncomeExtractionTests(unittest.TestCase):
    @staticmethod
    def line(text, y=100, x=100):
        return {"text": text, "score": 0.96, "y": y, "x": x, "h": 20}

    def test_extracts_income_from_1701_ms_digit_boxes_when_full_page_text_misses_digits(self):
        image = np.full((1924, 1224, 3), 255, dtype=np.uint8)
        for x in (669, 698, 727, 787, 816, 846):
            image[282:294, x : x + 7] = 0
        lines = [
            self.line("1701-MS 08/24 P2", y=136),
            self.line("1 Gross Compensation Income", y=288),
        ]
        seen = []

        def recognize(crops):
            seen.append(len(crops))
            return [
                (text, 0.9)
                for text in ("1", "8", "o", "5", "o", "o")
            ], 0.01

        extracted = extract_1701_ms_compensation_income(image, lines, recognize)

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 180_500)
        self.assertEqual(extracted["method"], "1701_ms_compensation_digit_boxes")
        self.assertEqual(seen, [6])

    def test_extracts_plain_integer_annual_income(self):
        extracted = extract_income([self.line("Total annual income 132000")])

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_extracts_integer_amount_in_a_separate_same_row_box(self):
        extracted = extract_income(
            [
                self.line("Gross compensation income"),
                self.line("132000", x=700),
            ]
        )

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_extracts_total_taxable_income_from_a_bir_form(self):
        extracted = extract_income([self.line("Total taxable income 132,000.00")])

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_extracts_labeled_1701_ms_income_and_tax_fields_separately(self):
        page1 = [
            self.line("1701-MS 08/24 P1", y=10),
            self.line("11 Source of Income Income from Business Compensation Income", y=100),
            self.line("23 Total Income Tax Due", y=500),
            self.line("7,580", y=500, x=700),
            self.line("29 Total Amount Payable/(Overpayment)", y=800),
            self.line("13,200", y=800, x=700),
        ]
        page2 = [
            self.line("1701-MS 08/24 P2", y=10),
            self.line("1 Gross Compensation Income", y=200),
            self.line("180500", y=200, x=700),
            self.line("3 Taxable Compensation Income", y=240),
            self.line("158800", y=240, x=700),
        ]

        page1_fields = extract_1701_ms_fields(page1, page_no=1)
        page2_fields = extract_1701_ms_fields(page2, page_no=2)

        self.assertEqual(
            [(field["field"], field["kind"], field["value"]) for field in page1_fields],
            [
                ("income_source_options", "source", "11 Source of Income Income from Business Compensation Income"),
                ("total_income_tax_due", "tax", 7_580),
                ("total_amount_payable", "tax", 13_200),
            ],
        )
        self.assertEqual(
            [(field["field"], field["kind"], field["value"]) for field in page2_fields],
            [
                ("gross_compensation_income", "income", 180_500),
                ("taxable_compensation_income", "income", 158_800),
            ],
        )

    def test_gross_income_from_operations_matches_the_printed_parentheses_label(self):
        # BIR 1701-MS Page 2 prints "Gross Income/(Loss) from Operation" - the
        # literal parentheses must not break the Item 9 anchor (priority 2 on
        # Page 2), or the extraction silently falls through to priority 3.
        page2 = [
            self.line("1701-MS 08/24 P2", y=10),
            self.line("9 Gross Income/(Loss) from Operation (Item 7 Less Item 8)", y=300),
            self.line("281,500", y=300, x=700),
            self.line("15 Total Taxable Income - Compensation & Business", y=400),
            self.line("376,950", y=400, x=700),
        ]

        fields = extract_1701_ms_fields(page2, page_no=2)

        self.assertEqual(
            [(field["field"], field["value"]) for field in fields],
            [("gross_business_income", 281_500), ("total_taxable_income", 376_950)],
        )
        pick = pick_priority_value(fields, page_no=2)
        self.assertEqual(pick["rank"], 2)
        self.assertEqual(pick["value"], 281_500)

    def test_1701_ms_field_extraction_does_not_read_tax_table_amounts_as_income(self):
        fields = extract_1701_ms_fields(
            [
                self.line("1701-MS 08/24 P2", y=10),
                self.line("If Taxable Income is: Over P 800,000 but not over P 2,000,000", y=900),
                self.line("P 102,500 + 25% of excess over P 800,000", y=920),
            ],
            page_no=2,
        )

        self.assertEqual(fields, [])

    def test_supports_annual_family_income_label_order_variation(self):
        extracted = extract_income([self.line("Total annual family income 132000")])

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_does_not_select_form_number_or_tax_year_before_income_amount(self):
        extracted = extract_income(
            [self.line("BIR Form 1701 Total annual income TY 2024 132,000.00")]
        )

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_parses_ocr_period_used_as_thousands_separator(self):
        extracted = extract_income([self.line("Total annual income 132.000")])

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 132_000)

    def test_match_percentage_is_based_on_declared_and_ocr_amounts(self):
        match = match_declared(132_000, 120_000)

        self.assertEqual(match["align_pct"], 90.91)
        self.assertEqual(match["status"], "mismatch")

    def test_total_income_tax_due_row_is_never_taken_as_the_income_figure(self):
        # Page 1 of the BIR 1701-MS prints "23 Total Income Tax Due (Sum of
        # Items 21 and 22) 7,580". The "total income" keyword must not grab
        # that tax figure - it would stop Page 2 (the real income row) from
        # ever being scanned.
        extracted = extract_income(
            [
                self.line("23 Total Income Tax Due (Sum of Items 21 and 22)"),
                self.line("7,580", x=700),
                self.line("Gross Compensation Income"),
                self.line("300,500", x=700, y=140),
            ]
        )

        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["value"], 300_500)
        self.assertIn("compensation income", extracted["method"])

    def test_tax_due_anchor_is_skipped_even_as_a_total_pattern_match(self):
        extracted = extract_income(
            [
                self.line("Total Income Tax Due 45,000"),
                self.line("Tax Payable 12,500"),
            ],
            allow_fallback=False,
        )

        self.assertIsNone(extracted)

    def test_render_ml_service_is_separate_from_vercel_frontend(self):
        repository_root = Path(__file__).resolve().parents[2]
        dockerfile = (repository_root / "Dockerfile").read_text(
            encoding="utf-8"
        )
        vercel_config = json.loads((repository_root / "vercel.json").read_text(encoding="utf-8"))

        self.assertEqual(set(vercel_config["services"]), {"app"})
        self.assertIn("backend/requirements.txt", dockerfile)

    def test_ml_health_reports_required_ocr_runtime_modules(self):
        with patch(
            "ml.service._probe_ocr_runtime",
            return_value={
                "ocr_runtime": {
                    "opencv": "4.10.0",
                    "onnxruntime": "1.24.0",
                    "sklearn": "1.7.0",
                    "rapidocr": "1.2.3",
                },
                "ocr_errors": [],
            },
        ):
            payload = json.loads(health().body)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["ocr_ready"])
        self.assertEqual(payload["ocr_runtime"]["opencv"], "4.10.0")
        self.assertEqual(payload["ocr_runtime"]["onnxruntime"], "1.24.0")
        self.assertEqual(payload["ocr_runtime"]["rapidocr"], "1.2.3")

    def test_ml_health_exposes_missing_ocr_dependencies_without_failing_service(self):
        with patch(
            "ml.service._probe_ocr_runtime",
            return_value={
                "ocr_runtime": {},
                "ocr_errors": [
                    "opencv-python: not installed",
                    "onnxruntime: not installed",
                    "rapidocr-onnxruntime: not installed",
                ],
            },
        ):
            payload = json.loads(health().body)

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["ocr_ready"])
        self.assertEqual(len(payload["ocr_errors"]), 3)

    def test_pipeline_child_crash_still_emits_error_and_done_events(self):
        process = SimpleNamespace(
            stdin=io.StringIO(),
            stdout=io.StringIO(),
            stderr=io.StringIO("native runtime crashed\n"),
            wait=lambda timeout: 137,
            kill=lambda: None,
        )
        with patch("ml.service.subprocess.Popen", return_value=process):
            events = [
                json.loads(line)
                for line in _stream_pipeline({"mode": "full"})
            ]

        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(events[-1]["ok"])
        error = next(event for event in events if event["type"] == "error")
        self.assertEqual(error["returncode"], 137)
        self.assertIn("native runtime crashed", error["stderr_tail"])

    def test_scan_analytics_leaves_match_percent_unavailable_without_ocr_income(self):
        record = {
            "linked": True,
            "ocr_value": None,
            "declared_income": 120_000,
            "match": {
                "align_pct": 0.0,
                "exact_match": False,
                "status": "not_comparable",
            },
            "skipped": None,
            "need_score": None,
            "confidence": 0.0,
            "ocr_ms": 1.0,
        }

        analytics = analytics_from({"itr.png": record}, 1.0)

        self.assertIsNone(analytics["match_rate_pct"])
        self.assertIsNone(analytics["avg_align_pct"])
        self.assertIsNone(analytics["typed_accuracy_pct"])
        self.assertIsNone(analytics["avg_confidence"])
        self.assertEqual(analytics["scan_failures"], 0)

    def test_scan_analytics_counts_engine_failures_separately_from_no_income(self):
        record = {
            "linked": True,
            "ocr_value": None,
            "declared_income": 120_000,
            "match": {
                "align_pct": 0.0,
                "exact_match": False,
                "status": "not_comparable",
            },
            "skipped": None,
            "need_score": None,
            "confidence": 0.0,
            "line_count": 0,
            "ocr_ms": 1.0,
            "scan_failure": True,
            "error": "No module named 'cv2'",
        }

        analytics = analytics_from({"itr.png": record}, 1.0)

        self.assertEqual(analytics["scan_failures"], 1)
        self.assertEqual(analytics["income_detected"], 0)
        self.assertIsNone(analytics["avg_confidence"])


class LayoutCellReaderTests(unittest.TestCase):
    """Per-row digit reading from the official 1701-MS layout boxes.

    Synthetic pages place black "printed digit" bars inside the exact
    amount-cell boxes of the BIR PDF layout (form_layout), the way a filled
    form does; the recognizer is stubbed so only the geometry, filtering and
    parsing logic is under test here (real recognition is covered by the
    sample-image validation runs).
    """

    @staticmethod
    def line(text, y, x=30, h=21):
        return {"text": text, "score": 0.96, "y": y, "x": x, "h": h}

    @staticmethod
    def blank_page():
        return np.full((1924, 1224, 3), 255, dtype=np.uint8)

    @staticmethod
    def draw_digits(image, x0, y0, specs):
        """specs: (rel_x, width, rel_y, height) bars inside the cell box."""
        for rx, rw, ry, rh in specs:
            image[y0 + ry : y0 + ry + rh, x0 + rx : x0 + rx + rw] = 0

    @staticmethod
    def recognizer(*answers):
        queue = list(answers)

        def recognize(_crops):
            return [(queue.pop(0), 0.9)], 0.01

        return recognize

    P1_LINES = [
        line.__func__("1701-MS 08/24 P1", y=10, h=10),
        line.__func__("23 Total Income Tax Due (Sum of Items 21 and 22)", y=983),
        line.__func__("25 Tax Payable/(Overpayment) (Item 23 Less Item 24)", y=1037),
        line.__func__(
            "29 Total Amount Payable/(Overpayment) (Sum of Items 27 and 28D)",
            y=1231,
        ),
    ]
    # item 23 cell px origin (657, 968); item 29 cell px origin (654, 1215)
    ITEM23_DIGITS = [(12, 7, 9, 11), (40, 7, 9, 11), (99, 7, 9, 11),
                     (128, 7, 9, 11), (157, 7, 9, 11)]
    ITEM29_DIGITS = [(11, 7, 8, 11), (70, 7, 8, 11), (100, 7, 8, 11),
                     (130, 7, 8, 11)]

    def test_reads_priority_rows_from_the_official_amount_boxes(self):
        image = self.blank_page()
        # item 23 = 19,000, item 29 = 8,800, item 25 cell left empty
        self.draw_digits(image, 657, 968, self.ITEM23_DIGITS)
        self.draw_digits(image, 654, 1215, self.ITEM29_DIGITS)

        fields = extract_1701_ms_layout_fields(
            image, self.P1_LINES, 1, self.recognizer("19000", "8800")
        )

        by_field = {field["field"]: field for field in fields}
        self.assertEqual(
            set(by_field), {"total_income_tax_due", "total_amount_payable"}
        )
        self.assertEqual(by_field["total_income_tax_due"]["value"], 19_000)
        self.assertEqual(
            by_field["total_income_tax_due"]["method"], "1701_ms_layout_cell"
        )
        self.assertEqual(by_field["total_amount_payable"]["value"], 8_800)
        self.assertEqual(
            by_field["total_income_tax_due"]["anchor"],
            "23 Total Income Tax Due (Sum of Items 21 and 22)",
        )

        pick = pick_priority_value(fields, page_no=1)
        self.assertEqual(pick["rank"], 1)
        self.assertEqual(pick["value"], 19_000)

    def test_empty_cell_falls_through_to_the_next_priority_row(self):
        image = self.blank_page()
        self.draw_digits(image, 654, 1215, self.ITEM29_DIGITS)

        fields = extract_1701_ms_layout_fields(
            image, self.P1_LINES, 1, self.recognizer("8800")
        )

        pick = pick_priority_value(fields, page_no=1)
        self.assertEqual(pick["rank"], 3)
        self.assertEqual(pick["value"], 8_800)

    def test_not_cleared_when_no_priority_cell_carries_a_value(self):
        image = self.blank_page()

        fields = extract_1701_ms_layout_fields(
            image, self.P1_LINES, 1, self.recognizer()
        )

        self.assertEqual(fields, [])
        self.assertIsNone(pick_priority_value(fields, page_no=1))

    def test_non_digit_recognizer_output_is_rejected_not_guessed(self):
        image = self.blank_page()
        self.draw_digits(image, 657, 968, self.ITEM23_DIGITS)

        fields = extract_1701_ms_layout_fields(
            image, self.P1_LINES, 1, self.recognizer("8..8.0.0")
        )

        self.assertEqual(fields, [])
        self.assertIsNone(pick_priority_value(fields, page_no=1))

    def test_low_confidence_strip_is_rejected(self):
        image = self.blank_page()
        self.draw_digits(image, 657, 968, self.ITEM23_DIGITS)

        def recognize(_crops):
            return [("19000", 0.05)], 0.01

        fields = extract_1701_ms_layout_fields(image, self.P1_LINES, 1, recognize)

        self.assertEqual(fields, [])

    def test_section_header_is_never_used_as_the_item_25_anchor(self):
        pattern = form_layout.FIELD_LAYOUT[1]["tax_payable_overpayment"][5]
        lines = [
            self.line("PART II - Total Income Tax Payable (DO NOT enter Centavos)", y=830),
            self.line("25 Tax Payable/(Overpayment) (Item 23 Less Item 24)", y=1037),
        ]

        anchor = _layout_anchor(lines, pattern, 1224)

        self.assertIsNotNone(anchor)
        self.assertIn("25 Tax Payable", anchor["text"])

    def test_reader_requires_the_1701_ms_header(self):
        image = self.blank_page()
        self.draw_digits(image, 657, 968, self.ITEM23_DIGITS)
        lines = [line for line in self.P1_LINES if "1701" not in line["text"]]

        fields = extract_1701_ms_layout_fields(
            image, lines, 1, self.recognizer()
        )

        self.assertEqual(fields, [])

    def test_page_two_gross_compensation_cell(self):
        image = self.blank_page()
        # item 1 cell px origin (657, 271) with the -4 px anchor shift
        self.draw_digits(
            image,
            657,
            271,
            [(12, 7, 11, 12), (40, 8, 11, 12), (70, 8, 11, 12),
             (130, 7, 11, 12), (159, 8, 11, 12), (189, 7, 11, 12)],
        )
        lines = [
            self.line("1701-MS 08/24 P2", y=10, h=10),
            self.line("1 Gross Compensation Income", y=288, x=33, h=24),
        ]

        fields = extract_1701_ms_layout_fields(
            image, lines, 2, self.recognizer("146500")
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["field"], "gross_compensation_income")
        self.assertEqual(fields[0]["value"], 146_500)
        pick = pick_priority_value(fields, page_no=2)
        self.assertEqual((pick["rank"], pick["value"]), (1, 146_500))


class ForestStub:
    feature_importances_ = [0.7, 0.3]
    n_estimators = 200
    n_features_in_ = 2

    def predict(self, rows):
        return [0 for _ in rows]


class FixedProbabilityClassifier:
    def __init__(self, probabilities):
        self.probabilities = probabilities

    def predict(self, rows):
        return [int(probability >= 0.5) for probability in self.probabilities]

    def predict_proba(self, rows):
        return np.asarray([[1.0 - probability, probability] for probability in self.probabilities])


class RankingAnalyticsTests(unittest.TestCase):
    def test_grades_are_not_model_features_or_priority_target_inputs(self):
        self.assertNotIn("academic_norm", features.FEATURE_COLUMNS)
        row = features.build_row(
            {
                "application_id": 1,
                "declared_income": 120_000,
                "shs_gwa": 99,
                "college_gpa": 4.0,
            },
            None,
        )
        self.assertNotIn("academic_norm", row)
        self.assertEqual(
            features.priority_target({"financial_need_score": 50, "academic_norm": 0.0}),
            features.priority_target({"financial_need_score": 50, "academic_norm": 1.0}),
        )

    def test_saved_grade_based_model_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "grades are no longer permitted"):
            predict(
                [{"application_id": 1}],
                {"feature_columns": ["academic_norm"], "medians": {}},
            )

    def test_ocr_income_is_audit_only_and_does_not_change_declared_income_model_features(self):
        applicant = {
            "application_id": 1,
            "declared_income": 120_000,
            "itr_path": "applicant/itr.png",
        }
        ocr_result = {
            "ocr_value": 300_000,
            "match": {"align_pct": 40.0, "exact_match": False, "status": "mismatch"},
        }

        row = features.build_row(applicant, ocr_result)
        alternate_ocr_row = features.build_row(
            applicant,
            {
                "ocr_value": 80_000,
                "match": {"align_pct": 66.7, "exact_match": False, "status": "mismatch"},
            },
        )

        self.assertEqual(row["income_used"], 120_000)
        self.assertEqual(row["income_source"], "declared_ocr_audit")
        self.assertEqual(row["annual_income_family"], 120_000)
        self.assertEqual(row["monthly_income_equiv"], 10_000)
        self.assertEqual(row["is_train_tax_exempt"], 1.0)
        self.assertEqual(row["itr_income_bracket"], 2.0)
        self.assertEqual(row["ocr_income"], 300_000)
        self.assertEqual(row["income_delta"], 180_000)
        self.assertTrue(row["ocr_income_differs"])
        self.assertEqual(row["ocr_match_pct"], 40.0)
        self.assertIsNone(row["ocr_error"])
        model_input, _ = features.matrix([row], columns=features.NOTEBOOK_FEATURE_COLUMNS)
        alternate_model_input, _ = features.matrix(
            [alternate_ocr_row],
            columns=features.NOTEBOOK_FEATURE_COLUMNS,
        )
        self.assertTrue(np.array_equal(model_input, alternate_model_input))
        full_model_input, _ = features.matrix([row], columns=features.FEATURE_COLUMNS)
        alternate_full_model_input, _ = features.matrix(
            [alternate_ocr_row],
            columns=features.FEATURE_COLUMNS,
        )
        self.assertTrue(np.array_equal(full_model_input, alternate_full_model_input))

    def test_any_ocr_confidence_uses_declared_income_for_ranking(self):
        row = features.build_row(
            {"application_id": 1, "declared_income": 120_000, "itr_path": "applicant/itr.png"},
            {
                "ocr_value": 300_000,
                "low_confidence": True,
                "match": {"align_pct": 40.0, "exact_match": False, "status": "mismatch"},
            },
        )

        self.assertEqual(row["income_used"], 120_000)
        self.assertEqual(row["income_source"], "declared_ocr_audit")
        self.assertEqual(row["annual_income_family"], 120_000)

    def test_ocr_does_not_replace_missing_declared_income(self):
        row_with_ocr = features.build_row(
            {"application_id": 1, "declared_income": None, "itr_path": "applicant/itr.png"},
            {"ocr_value": 300_000},
        )
        row_without_ocr = features.build_row(
            {"application_id": 1, "declared_income": None, "itr_path": "applicant/itr.png"},
            None,
        )

        self.assertIsNone(row_with_ocr["income_used"])
        self.assertEqual(row_with_ocr["income_source"], "none")
        with_ocr, _ = features.matrix([row_with_ocr], columns=features.FEATURE_COLUMNS)
        without_ocr, _ = features.matrix([row_without_ocr], columns=features.FEATURE_COLUMNS)
        self.assertTrue(np.array_equal(with_ocr, without_ocr))

    def test_tax_bracket_and_explanatory_note_amounts_are_not_income(self):
        lines = [
            {"text": "If Taxable Income is:", "score": 0.96, "y": 100, "x": 100, "h": 20},
            {"text": "800,000", "score": 0.96, "y": 125, "x": 100, "h": 20},
            {"text": "but not over P 2,000,000", "score": 0.96, "y": 145, "x": 100, "h": 20},
            {"text": "IfTaxableIncomeis:", "score": 0.96, "y": 200, "x": 100, "h": 20},
            {"text": "800.000", "score": 0.96, "y": 225, "x": 100, "h": 20},
            {"text": "21 Total Income (Sum of Items 19 and 20)", "score": 0.96, "y": 500, "x": 100, "h": 20},
            {
                "text": "and/or professionals in the amount of P250.000 "
                "(not applicable if with compensation income)",
                "score": 0.96,
                "y": 530,
                "x": 100,
                "h": 20,
            },
            {"text": "I1011 Compensation Income", "score": 0.96, "y": 600, "x": 100, "h": 20},
            {
                "text": "TABLE 2-Tax Rates (effective January 1, 2023 and onwards)",
                "score": 0.96,
                "y": 625,
                "x": 100,
                "h": 20,
            },
            {"text": "I1016 Mixed Income8% IT Rate", "score": 0.96, "y": 650, "x": 100, "h": 20},
            {
                "text": "P 2,202,500 + 35% of the excess over P 8,000,000",
                "score": 0.96,
                "y": 675,
                "x": 100,
                "h": 20,
            },
            {"text": "Not over P 250,000", "score": 0.96, "y": 700, "x": 100, "h": 20},
        ]

        extracted = extract_income(lines, allow_fallback=True)

        self.assertIsNone(extracted)

    def test_build_row_keeps_both_itr_paths_for_ranking_results(self):
        row = features.build_row(
            {
                "application_id": 1,
                "declared_income": 120_000,
                "itr_path": "student/itr-page-1.png",
                "itr_path_p2": "student/itr-page-2.png",
            },
            {"ocr_value": 120_000, "match": {"align_pct": 100, "status": "match"}},
        )

        self.assertEqual(row["itr_path"], "student/itr-page-1.png")
        self.assertEqual(row["itr_path_p2"], "student/itr-page-2.png")

    def test_unreadable_itr_is_not_reported_as_a_zero_percent_mismatch(self):
        row = features.build_row(
            {"application_id": 1, "declared_income": 120_000, "itr_path": "student/itr.png"},
            {
                "ocr_value": None,
                "error": "No income value detected in the ITR image",
                "scan_failure": False,
                "match": {
                    "align_pct": 0.0,
                    "exact_match": False,
                    "status": "not_comparable",
                },
            },
        )

        self.assertEqual(row["itr_trust"], "unverified")
        self.assertFalse(row["ocr_scan_failed"])
        self.assertEqual(row["ocr_error"], "No income value detected in the ITR image")

    def test_ocr_engine_failure_is_exposed_separately_from_missing_income(self):
        row = features.build_row(
            {"application_id": 1, "declared_income": 120_000, "itr_path": "student/itr.png"},
            {
                "ocr_value": None,
                "error": "No module named 'cv2'",
                "scan_failure": True,
                "match": {
                    "align_pct": 0.0,
                    "exact_match": False,
                    "status": "not_comparable",
                },
            },
        )

        self.assertTrue(row["ocr_scan_failed"])
        self.assertEqual(row["ocr_error"], "No module named 'cv2'")

    def test_sheet_reader_parses_upload_bytes(self):
        parsed = _parse_sheet(
            "previous-applications.csv",
            b"Student ID,Program,Year Level\n1001,Computer Science,2\n1002,Nursing,3\n",
        )

        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["columns"], ["Student ID", "Program", "Year Level"])
        self.assertEqual(parsed["row_count"], 2)
        self.assertEqual(parsed["year_kind"], "level")

    def test_sheet_reader_parses_excel_upload_bytes(self):
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(["Student ID", "Program", "Year Level"])
        worksheet.append([1001, "Computer Science", 2])
        content = BytesIO()
        workbook.save(content)

        parsed = _parse_sheet("previous-applications.xlsx", content.getvalue())

        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["row_count"], 1)
        self.assertEqual(parsed["rows"][0]["Student ID"], "1001")
        self.assertEqual(parsed["year_kind"], "level")

    def test_sheet_reader_rejects_bad_type_and_oversized_upload(self):
        with self.assertRaises(HTTPException) as bad_type:
            _parse_sheet("legacy.xls", b"")
        with self.assertRaises(HTTPException) as too_large:
            _parse_sheet("oversized.csv", b"x" * (MAX_SHEET_BYTES + 1))

        self.assertEqual(bad_type.exception.status_code, 400)
        self.assertEqual(too_large.exception.status_code, 413)

    def test_training_loader_marks_observed_npcinc_labels_separately(self):
        resolved = _resolve({"toinc": "TOINC", "npcinc": "NPCINC"})
        observed = row_from({"TOINC": "120000", "NPCINC": "4"}, resolved, income_ranked=True)
        proxy = row_from({"TOINC": "120000"}, resolved, income_ranked=True)

        self.assertEqual(observed["priority_target"], 100.0)
        self.assertEqual(observed["target_source"], "npcinc")
        self.assertEqual(proxy["target_source"], "income_proxy")

    def test_colab_income_features_accept_zero_income(self):
        resolved = _resolve({"toinc": "TOINC", "npcinc": "NPCINC"})

        row = row_from({"TOINC": "0", "NPCINC": "1"}, resolved, income_ranked=True)

        self.assertEqual(row["annual_income_family"], 0.0)
        self.assertEqual(row["priority_target"], 100.0)
        self.assertEqual(row["itr_income_bracket"], 1.0)

    def test_notebook_feature_columns_match_the_five_column_notebook(self):
        # The panel's Colab notebook trains on exactly these five income
        # columns, in this order - nothing else may leak into the train-only
        # feature matrix or the app and the notebook would disagree.
        self.assertEqual(
            features.NOTEBOOK_FEATURE_COLUMNS,
            [
                "annual_income_family",
                "monthly_income_equiv",
                "is_train_tax_exempt",
                "is_ched_priority_ceiling",
                "itr_income_bracket",
            ],
        )
        # household size / per-capita are still carried on the rows (used by
        # other scoring paths), just not as notebook training features.
        for column in ("family_size", "per_capita_income"):
            self.assertIn(column, features.FEATURE_COLUMNS)

    def test_training_file_rows_carry_household_size(self):
        resolved = _resolve({"toinc": "TOINC", "npcinc": "NPCINC", "fsize": "FSIZE"})

        row = row_from(
            {"TOINC": "240000", "NPCINC": "3", "FSIZE": "6"},
            resolved,
            income_ranked=True,
        )

        self.assertEqual(row["family_size"], 6.0)
        self.assertEqual(row["per_capita_income"], 40_000.0)

    def test_family_size_validation_and_neutral_default(self):
        resolved = _resolve({"toinc": "TOINC", "fsize": "FSIZE"})

        missing = row_from({"TOINC": "240000"}, resolved)
        invalid = row_from({"TOINC": "240000", "FSIZE": "0"}, resolved)

        self.assertTrue(math.isnan(missing["family_size"]))
        # income / neutral household size (4), not the dataset median per-capita
        self.assertEqual(missing["per_capita_income"], 60_000.0)
        self.assertTrue(math.isnan(invalid["family_size"]))

        declared = features.build_row({"declared_income": 240_000, "family_size": 6}, None)
        self.assertEqual(declared["family_size"], 6.0)
        self.assertEqual(declared["per_capita_income"], 40_000.0)

        no_answer = features.build_row({"declared_income": 240_000}, None)
        self.assertTrue(math.isnan(no_answer["family_size"]))
        self.assertEqual(no_answer["per_capita_income"], 60_000.0)

        self.assertEqual(features.family_size("5"), 5.0)
        self.assertTrue(math.isnan(features.family_size("five")))
        self.assertTrue(math.isnan(features.family_size(25)))

    def test_training_loader_drops_exact_duplicate_rows(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["TOINC", "FSIZE", "NPCINC"])
        for _ in range(3):
            sheet.append([240_000, 5, 3])
        sheet.append([300_000, 2, 6])

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "training.xlsx"
            workbook.save(path)
            rows, warnings = load_training_csv(path, income_ranked=True)

        # 2 unique households kept, the 2 repeated copies dropped
        self.assertEqual(len(rows), 2)
        self.assertTrue(any("duplicate row(s) removed" in w for w in warnings))
        self.assertTrue(any("Income range check" in w for w in warnings))
        self.assertTrue(any("Family size present on 2 of 2" in w for w in warnings))

    def test_build_docs_only_includes_selected_applicant_itr_files(self):
        applicants = [
            {
                "itr_path": f"student/{index}.png",
                "application_id": index,
                "declared_income": 100_000,
            }
            for index in range(1, 10)
        ]
        bucket_files = [
            {"path": f"student/{index}.png", "size": 50_000, "updated_at": None}
            for index in range(1, 41)
        ]

        with patch("ml.pipeline.storage.list_all", return_value=bucket_files):
            docs = build_docs(applicants)

        self.assertEqual(len(docs), 9)
        self.assertTrue(all(doc["linked"] for doc in docs))
        self.assertEqual({doc["application_id"] for doc in docs}, set(range(1, 10)))

    def test_build_docs_attaches_the_second_itr_page_and_its_storage_meta(self):
        applicants = [
            {
                "itr_path": "student/1.png",
                "itr_path_p2": "student/1_p2.png",
                "application_id": 1,
                "declared_income": 100_000,
            },
            {"itr_path": "student/2.png", "application_id": 2, "declared_income": 90_000},
            {
                "itr_path_p2": "student/3_p2.png",
                "application_id": 3,
                "declared_income": 80_000,
            },
        ]
        bucket_files = [
            {"path": "student/1.png", "size": 50_000, "updated_at": "t1"},
            {"path": "student/1_p2.png", "size": 60_000, "updated_at": "t2"},
            {"path": "student/2.png", "size": 40_000, "updated_at": "t3"},
            {"path": "student/3_p2.png", "size": 30_000, "updated_at": "t4"},
        ]

        with patch("ml.pipeline.storage.list_all", return_value=bucket_files):
            docs = build_docs(applicants)

        with_two_pages = next(doc for doc in docs if doc["application_id"] == 1)
        without = next(doc for doc in docs if doc["application_id"] == 2)
        self.assertEqual(with_two_pages["path2"], "student/1_p2.png")
        self.assertEqual(with_two_pages["size2"], 60_000)
        self.assertEqual(with_two_pages["updated_at2"], "t2")
        self.assertNotIn("path2", without)
        page2_only = next(doc for doc in docs if doc["application_id"] == 3)
        self.assertEqual(page2_only["path"], "student/3_p2.png")
        self.assertEqual(page2_only["page_no"], 2)

        # The cache key must change when EITHER page changes, otherwise a
        # re-uploaded Page 2 would silently reuse Page 1's stale OCR result.
        key_before = pipeline_cache_id(with_two_pages)
        changed = dict(with_two_pages, updated_at2="t9")
        self.assertNotEqual(key_before, pipeline_cache_id(changed))
        single = pipeline_cache_id(without)
        self.assertEqual(single[0], "student/2.png")

    def test_shared_itr_path_keeps_ocr_results_for_each_bulk_application(self):
        applicants = [
            {
                "itr_path": "student/shared.png",
                "application_id": application_id,
                "declared_income": income,
            }
            for application_id, income in ((10, 100_000), (11, 120_000))
        ]
        with patch("ml.pipeline.storage.list_all", return_value=[
            {"path": "student/shared.png", "size": 20_000, "updated_at": "t1"},
        ]):
            docs = build_docs(applicants)

        def fake_scan(doc):
            return {
                "path": doc["path"],
                "path2": None,
                "application_id": doc["application_id"],
                "student_name": None,
                "declared_income": doc["declared_income"],
                "linked": True,
                "ocr_value": 90_000,
                "match": {
                    "exact_match": False,
                    "align_pct": 90.0,
                    "diff": 10_000,
                    "status": "mismatch",
                },
                "confidence": 0.9,
                "ocr_ms": 1.0,
                "line_count": 1,
                "error": None,
                "cached": False,
                "need_score": None,
                "low_confidence": False,
                "scan_failure": False,
                "skipped": None,
            }

        with (
            patch("ml.pipeline.ocr_cache.get", return_value=None),
            patch("ml.pipeline.ocr_cache.put"),
            patch("ml.pipeline._scan_one", side_effect=fake_scan),
        ):
            results, _analytics = pipeline.scan_documents(docs)

        linked = index_by_application(results)
        self.assertEqual(set(linked), {10, 11})
        self.assertEqual(linked[10]["declared_income"], 100_000)
        self.assertEqual(linked[11]["declared_income"], 120_000)

    def test_scan_retries_cache_created_with_fewer_ocr_variants(self):
        doc = {
            "path": "student/itr.png",
            "size": 20_000,
            "updated_at": "t1",
            "application_id": 1,
            "student_name": "Test applicant",
            "declared_income": 300_500,
            "linked": True,
        }
        scanned_record = {
            "path": doc["path"],
            "application_id": doc["application_id"],
            "student_name": doc["student_name"],
            "declared_income": doc["declared_income"],
            "linked": True,
            "ocr_value": 300_500,
            "match": {
                "exact_match": True,
                "align_pct": 100.0,
                "diff": 0.0,
                "status": "match",
            },
            "confidence": 0.99,
            "ocr_ms": 1.0,
            "line_count": 1,
            "error": None,
            "cached": False,
            "need_score": None,
            "low_confidence": False,
            "scan_failure": False,
            "skipped": None,
            "ocr_max_variants": 3,
        }

        with (
            patch("ml.pipeline.cfg.OCR_MAX_VARIANTS", 3),
            patch(
                "ml.pipeline.ocr_cache.get",
                return_value={"ocr_value": None, "ocr_max_variants": 0},
            ),
            patch("ml.pipeline.ocr_cache.put") as cache_put,
            patch("ml.pipeline._scan_one", return_value=scanned_record) as scan,
            patch("ml.pipeline.emit"),
            patch("ml.pipeline.log"),
            patch("ml.pipeline.analytics_from", return_value={}),
        ):
            results, _analytics = pipeline.scan_documents([doc])

        scan.assert_called_once_with(doc)
        cache_put.assert_called_once()
        self.assertEqual(results["app-1"]["ocr_value"], 300_500)

    def test_external_model_restores_saved_training_analytics(self):
        analytics = {
            "accuracy": 0.741,
            "precision": 0.755,
            "recall": 0.802,
            "f1": 0.777,
            "roc_auc": 0.7945,
            "evaluation": {
                "available": True,
                "source": "observed NPCINC <= 4",
                "n_test": 200,
                "n_train": 800,
            },
            "confusion_matrix": [[100, 20], [15, 80]],
            "r2": 0.61,
            "rmse": 12.3,
            "feature_importance": {"annual_income_family": 0.7, "year_level": 0.3},
            "dataset": {"total": 10_006, "sources": {"csv": 10_006, "synthetic": 0, "real": 0}},
            "train_ms": 3_732.4,
        }
        payload = {
            "regressor": ForestStub(),
            "feature_columns": ["annual_income_family", "year_level"],
            "n_samples": 10_006,
            "n_csv": 10_006,
            "n_trees": 200,
            "analytics": analytics,
        }

        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "scholarship_rf_model.joblib"
            joblib.dump(payload, model_path)

            model = load_external(path=model_path)

        self.assertEqual(model["accuracy"], analytics["accuracy"])
        self.assertEqual(model["f1"], analytics["f1"])
        self.assertEqual(model["roc_auc"], analytics["roc_auc"])
        self.assertEqual(model["confusion_matrix"], analytics["confusion_matrix"])
        self.assertEqual(model["dataset"], analytics["dataset"])
        self.assertEqual(model["evaluation"], analytics["evaluation"])
        self.assertEqual(model["feature_importance"], analytics["feature_importance"])

    def test_external_model_download_creates_nested_cache_directory(self):
        payload = {
            "regressor": ForestStub(),
            "feature_columns": ["annual_income_family", "year_level"],
        }

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.joblib"
            runtime_model_dir = Path(directory) / "runtime"
            joblib.dump(payload, source)

            with (
                patch("ml.rank_model._config.MODEL_DIR", runtime_model_dir),
                patch("ml.rank_model._config.external_model_path", return_value=None),
                patch("ml.storage.download", return_value=source.read_bytes()),
            ):
                model = load_external()

            cached = runtime_model_dir / "models" / "scholarship_rf_model.joblib"
            self.assertTrue(cached.is_file())
            self.assertIsNotNone(model)
            self.assertTrue(model["persisted"])

    def test_external_model_download_surfaces_storage_errors_other_than_not_found(self):
        from ml.storage import StorageError

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("ml.rank_model._config.MODEL_DIR", Path(directory)),
                patch("ml.rank_model._config.external_model_path", return_value=None),
                patch(
                    "ml.storage.download",
                    side_effect=StorageError("download failed: HTTP 503", 503),
                ),
            ):
                with self.assertRaises(StorageError):
                    load_external()

    def test_external_model_missing_from_storage_allows_local_training_fallback(self):
        from ml.storage import StorageError

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("ml.rank_model._config.MODEL_DIR", Path(directory)),
                patch("ml.rank_model._config.external_model_path", return_value=None),
                patch(
                    "ml.storage.download",
                    side_effect=StorageError("signed URL failed: HTTP 404", 404),
                ),
            ):
                self.assertIsNone(load_external())

    def test_external_model_hides_legacy_proxy_metrics_without_label_provenance(self):
        payload = {
            "regressor": ForestStub(),
            "feature_columns": ["annual_income_family", "year_level"],
            "analytics": {"accuracy": 0.99, "f1": 0.99, "roc_auc": 1.0},
        }
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "legacy.joblib"
            joblib.dump(payload, model_path)
            model = load_external(path=model_path)

        self.assertFalse(model["evaluation"]["available"])
        self.assertIsNone(model["model_id"])
        self.assertIsNone(model["accuracy"])
        self.assertIsNone(model["f1"])
        self.assertIsNone(model["roc_auc"])

    def test_training_persists_analytics_with_deployed_model(self):
        rows = []
        for index in range(60):
            income = 30_000 + index * 10_000
            label = index % 2
            rows.append(
                {
                    "annual_income_family": income,
                    "monthly_income_equiv": features.monthly_income_equiv(income),
                    "is_train_tax_exempt": features.is_train_tax_exempt(income),
                    "is_ched_priority_ceiling": features.is_ched_priority_ceiling(income),
                    "itr_income_bracket": features.itr_income_bracket(income),
                    "priority_target": 100.0 if label else 0.0,
                    "target_source": "npcinc",
                    "npcinc": 4 if label else 5,
                    "income_used": income,
                    "financial_need_score": features.financial_need_score(income),
                    "has_itr": 1,
                    "ocr_verified": 1,
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            model_dir = Path(directory)
            with (
                patch("ml.rank_model._config.MODEL_DIR", model_dir),
                patch("ml.storage.upload"),
            ):
                trained = train(
                    [],
                    seed=42,
                    n_trees=5,
                    n_synth=0,
                    max_depth=3,
                    min_samples_leaf=1,
                    income_ranked=True,
                    csv_rows_override=rows,
                    columns=features.NOTEBOOK_FEATURE_COLUMNS,
                )
                restored = load_external(path=trained["deployed_path"])
                payload = joblib.load(trained["deployed_path"])

        self.assertTrue(trained["persisted"])
        self.assertTrue(trained["evaluation"]["available"])
        self.assertEqual(trained["evaluation"]["n_test"], 12)
        self.assertEqual(payload["analytics"]["accuracy"], trained["accuracy"])
        self.assertEqual(restored["accuracy"], trained["accuracy"])
        self.assertEqual(restored["f1"], trained["f1"])
        self.assertEqual(restored["roc_auc"], trained["roc_auc"])
        self.assertEqual(restored["dataset"], trained["dataset"])
        self.assertEqual(restored["evaluation"], trained["evaluation"])
        self.assertRegex(trained["model_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(payload["model_id"], trained["model_id"])
        self.assertEqual(restored["model_id"], trained["model_id"])
        self.assertNotIn("coverage", trained["dataset"])
        self.assertTrue(restored["persisted"])
        self.assertIsNone(payload["regressor"])
        classifier_params = trained["classifier"].get_params()
        self.assertEqual(classifier_params["n_estimators"], 5)
        self.assertEqual(classifier_params["max_depth"], 3)
        self.assertEqual(classifier_params["min_samples_leaf"], 1)
        self.assertEqual(classifier_params["min_samples_split"], 2)
        self.assertEqual(classifier_params["class_weight"], "balanced")
        self.assertEqual(classifier_params["random_state"], 42)
        self.assertEqual(classifier_params["n_jobs"], 1)

    def test_income_proxy_targets_are_not_reported_as_model_accuracy(self):
        rows = []
        for index in range(60):
            income = 30_000 + index * 10_000
            need = features.financial_need_score(income)
            rows.append(
                {
                    "annual_income_family": income,
                    "monthly_income_equiv": features.monthly_income_equiv(income),
                    "is_train_tax_exempt": features.is_train_tax_exempt(income),
                    "is_ched_priority_ceiling": features.is_ched_priority_ceiling(income),
                    "itr_income_bracket": features.itr_income_bracket(income),
                    "priority_target": need,
                    "income_used": income,
                    "financial_need_score": need,
                    "has_itr": 1,
                    "ocr_verified": 1,
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            with patch("ml.rank_model._config.MODEL_DIR", Path(directory)):
                trained = train(
                    [],
                    seed=42,
                    n_trees=5,
                    n_synth=0,
                    max_depth=3,
                    min_samples_leaf=1,
                    income_ranked=False,
                    csv_rows_override=rows,
                    columns=features.NOTEBOOK_FEATURE_COLUMNS,
                )

        self.assertFalse(trained["evaluation"]["available"])
        self.assertEqual(trained["evaluation"]["n_test"], 0)
        self.assertIsNone(trained["accuracy"])
        self.assertIsNone(trained["f1"])
        self.assertIsNone(trained["roc_auc"])

    def test_model_probability_orders_applicants_before_income_tiebreak(self):
        rows = [
            {
                "application_id": 1,
                "income_used": 100_000,
                "annual_income_family": 100_000,
                "has_itr": 0,
                "ocr_match_pct": 0,
            },
            {
                "application_id": 2,
                "income_used": 200_000,
                "annual_income_family": 200_000,
                "has_itr": 1,
                "ocr_match_pct": 100,
            },
            {
                "application_id": 3,
                "income_used": 150_000,
                "annual_income_family": 150_000,
                "has_itr": 1,
                "ocr_match_pct": 10,
            },
        ]
        model = {
            "regressor": None,
            "classifier": FixedProbabilityClassifier([0.2, 0.9, 0.9]),
            "feature_columns": ["annual_income_family"],
            "medians": {"annual_income_family": 0},
        }

        ranked = predict(rows, model)

        self.assertEqual([row["application_id"] for row in ranked], [3, 2, 1])
        self.assertEqual([row["rank"] for row in ranked], [1, 2, 3])
        self.assertEqual([row["priority_score"] for row in ranked], [90.0, 90.0, 20.0])

    def test_ranked_row_does_not_show_zero_match_when_ocr_found_no_income(self):
        model = {
            "regressor": None,
            "classifier": FixedProbabilityClassifier([0.8]),
            "feature_columns": ["annual_income_family"],
            "medians": {"annual_income_family": 0},
        }
        rows = [
            {
                "application_id": 1,
                "income_used": 120_000,
                "annual_income_family": 120_000,
                "has_itr": 1,
                "itr_path": "student/itr.png",
                "itr_path_p2": "student/itr_p2.png",
                "ocr_income": None,
                "ocr_match_pct": 0.0,
                "ocr_status": "not_comparable",
            }
        ]

        ranked = predict(rows, model)

        self.assertIsNone(ranked[0]["ocr_match_pct"])
        self.assertEqual(ranked[0]["itr_trust"], "unverified")
        self.assertEqual(ranked[0]["itr_path"], "student/itr.png")
        self.assertEqual(ranked[0]["itr_path_p2"], "student/itr_p2.png")

    def test_colab_training_requires_observed_npcinc_labels(self):
        rows = [
            {
                "annual_income_family": 120_000,
                "priority_target": 80,
                "target_source": "income_proxy",
            }
        ]

        with tempfile.TemporaryDirectory() as directory:
            with patch("ml.rank_model._config.MODEL_DIR", Path(directory)):
                with self.assertRaisesRegex(ValueError, "NPCINC"):
                    train(
                        [],
                        seed=42,
                        n_trees=5,
                        n_synth=0,
                        income_ranked=True,
                        csv_rows_override=rows,
                        columns=features.NOTEBOOK_FEATURE_COLUMNS,
                    )

    def test_colab_upload_validation_rejects_rows_skipped_for_missing_income(self):
        from ml.pipeline import validate_colab_training_upload

        with self.assertRaisesRegex(ValueError, "TOINC.*NPCINC"):
            validate_colab_training_upload(
                [{"annual_income_family": 100_000}],
                ["training data line 3: skipped (nothing usable)"],
            )

    def test_uploaded_training_and_ranking_uses_one_fresh_file_only_model(self):
        from ml import csv_data, pipeline

        training_rows = [{"annual_income_family": 90_000, "priority_target": 100}]
        training_result = {
            "classifier": object(),
            "regressor": object(),
            "medians": {},
            "feature_columns": list(features.NOTEBOOK_FEATURE_COLUMNS),
            "n_samples": 1,
            "n_real": 0,
            "n_synthetic": 0,
            "n_csv": 1,
            "n_trees": 200,
            "seed": 42,
            "evaluation": {"available": True, "source": "observed NPCINC <= 4", "n_test": 1, "n_train": 0},
            "feature_importance": {},
            "dataset": {"sources": {"csv": 1, "synthetic": 0, "real": 0}, "total": 1},
            "model_path": "model.joblib",
            "model_size_kb": 1,
            "deployed_path": "scholarship_rf_model.joblib",
            "persisted": True,
            "train_ms": 1,
            "csv_warnings": [],
        }
        ranked_rows = [
            {
                "application_id": 10,
                "rank": 1,
                "priority_score": 99,
                "prediction": "High Need",
                "financial_need_score": 96,
                "ocr_match_pct": 0,
                "income_used": 120_000,
                "income_source": "declared",
            }
        ]
        payload = {
            "mode": "rank",
            "train_uploaded": True,
            "seed": 42,
            "n_trees": 200,
            "n_synth": 0,
            "max_depth": 3,
            "min_samples_leaf": 200,
            "applicants": [
                {
                    "application_id": 10,
                    "student_name": "Test Applicant",
                    "declared_income": 120_000,
                    "itr_path": None,
                }
            ],
        }
        output = io.StringIO()

        with (
            patch("sys.stdin", io.StringIO(json.dumps(payload))),
            patch("sys.stdout", output),
            patch.object(csv_data, "load_training_csv", return_value=(training_rows, [])),
            patch.object(pipeline.storage, "list_all", return_value=[]),
            patch.object(pipeline.rank_model, "train", return_value=training_result) as train_mock,
            patch.object(pipeline.rank_model, "predict", return_value=ranked_rows) as predict_mock,
        ):
            result = pipeline.main()

        self.assertEqual(result, 0, output.getvalue())
        train_kwargs = train_mock.call_args.kwargs
        self.assertEqual(train_kwargs["n_synth"], 0)
        self.assertTrue(train_kwargs["income_ranked"])
        self.assertEqual(train_kwargs["csv_rows_override"], training_rows)
        self.assertEqual(train_kwargs["columns"], features.NOTEBOOK_FEATURE_COLUMNS)
        predict_mock.assert_called_once()
        self.assertIs(predict_mock.call_args.args[1], training_result)
        events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith("{")]
        self.assertTrue(any(event.get("type") == "train" for event in events))
        self.assertTrue(any(event.get("type") == "rank" for event in events))
        self.assertTrue(next(event for event in events if event.get("type") == "done")["ok"])


if __name__ == "__main__":
    unittest.main()
