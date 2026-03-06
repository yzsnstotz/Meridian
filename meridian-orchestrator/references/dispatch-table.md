# 📋 Meridian v2.0 Dispatch Table

This table is derived from `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`.

| Wave (Phase) | Worker | Tasks to Execute | Session Strategy | Wait For (Code Dependencies) |
| :--- | :--- | :--- | :--- | :--- |
| **Wave 1** (Phase 0) | **W1** | T-01 | **New Session** | None |
| | **W2** | T-03 | **New Session** | None |
| **Wave 2** (Phase 1) | **W1** | T-02, T-06, T-07 | **New Session** | W1: T-01 <br>W2: T-03 |
| | **W2** | T-04, T-05, T-11 | **New Session** | W2: T-03 <br>W1: T-02 (for T-11) |
| | **W3** | T-10 | **New Session** | W1: T-01 <br>W2: T-03, T-04, T-05 |
| **Wave 3** (Phase 2) | **W1** | T-08, T-13 | **New Session** | W1: T-06 <br>W3: T-10 |
| | **W2** | T-09, T-14, T-15, T-16 | **Share Session** *(from W2)* | W2: T-03, T-05 |
| | **W3** | T-12 | **New Session** | W3: T-10 <br>W2: T-11 |
| **Wave 4** (Phase 3) | **W4** | T-17 | **New Session** | All P1 Tasks Complete |
