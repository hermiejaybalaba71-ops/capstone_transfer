# -*- coding: utf-8 -*-
"""Official BIR 1701-MS (August 2024) row/column layout, in PDF points.

The layout is extracted from the official BIR fillable PDF
(``1701-MS August 2024 Fillable_01.pdf``) with pdfplumber - never from a
filled-in sample, so nothing learned here leaks a taxpayer's data. The page
coordinate space is 612 x 936 pt; the reader scales it to the uploaded
image by ``width / 612`` and shifts it vertically using the OCR-detected
label line of the same row (which absorbs any top/bottom margin a photo or
a cropped scan introduces).

``FIELD_LAYOUT[page_no][field_key]`` holds::

    (cell_x0, cell_top, cell_x1, cell_bottom, label_top, strict_pattern)

* ``cell_*``      - the column-A amount box of that row (where the printed
                    digits live, comb cells included),
* ``label_top``   - top of the printed label row in points, used to align
                    the cell box with the OCR-detected label line,
* ``strict_pattern`` - regex that only matches the row's own label line
                    (it requires the leading item number, so section
                    headers such as "PART II - Total Income Tax Payable"
                    can never be mistaken for item 25's label).
"""

from typing import Dict, Tuple

# Width of the PDF page in points; scale = image_width / PAGE_WIDTH_PT.
PAGE_WIDTH_PT = 612.0

LayoutRow = Tuple[float, float, float, float, float, str]

FIELD_LAYOUT: Dict[int, Dict[str, LayoutRow]] = {
    1: {
        "total_income_tax_due": (
            328.5, 483.8, 460.2, 496.8, 486.2,
            r"^\s*23\s*total\s*income\s*tax\s*due\b",
        ),
        "tax_payable_overpayment": (
            329.2, 511.1, 460.4, 524.0, 513.5,
            r"^\s*25\s*tax\s*payable\b",
        ),
        "total_amount_payable": (
            327.1, 607.5, 460.6, 620.4, 610.1,
            r"^\s*29\s*total\s*amount\s*payable\b",
        ),
        "aggregate_amount_payable": (
            403.5, 622.9, 537.0, 635.8, 625.3,
            r"^\s*30\s*aggregate\s*amount\s*payable\b",
        ),
    },
    2: {
        "gross_compensation_income": (
            328.5, 137.3, 461.9, 151.5, 140.0,
            r"^\s*1\s*gross\s*compensation\s*income\b",
        ),
        "taxable_compensation_income": (
            328.3, 166.3, 461.3, 180.3, 169.6,
            r"^\s*3\s*taxable\s*compensation\s*income\b",
        ),
        "gross_business_income": (
            327.4, 283.1, 460.4, 297.1, 286.5,
            r"^\s*9\s*gross\s*income.*from\s*operation\b",
        ),
        "net_business_income": (
            328.2, 392.8, 461.2, 406.8, 395.9,
            r"^\s*12\s*net\s*income",
        ),
        "taxable_business_income": (
            327.6, 422.3, 460.6, 436.3, 425.5,
            r"^\s*14\s*taxable\s*income.*business\b",
        ),
        "total_taxable_income": (
            327.9, 437.1, 460.9, 451.1, 440.3,
            r"^\s*15\s*total\s*taxable\s*income\b",
        ),
        "total_tax_due_compensation": (
            328.6, 486.0, 461.6, 503.5, 487.4,
            r"^\s*18\s*A\s*total\s*tax\s*due\b",
        ),
        "total_tax_due_business": (
            327.6, 505.5, 460.6, 521.8, 506.6,
            r"^\s*18\s*B\s*total\s*tax\s*due\b",
        ),
    },
}
