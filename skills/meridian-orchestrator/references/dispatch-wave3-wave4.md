# Meridian v2.0 — Wave 3 & Wave 4 Dispatch

**Taskspec:** `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`  
**Precondition:** Wave 1 and Wave 2 are complete.

Workers must open the taskspec document above and execute only the task IDs listed below. Do not rely on task text pasted here; the document is the single source of truth.

---

## Wave 3 (Phase 2)

### W1 — Wave 3

**Role:** Worker 1 (W1)  
**Wave:** Wave 3  
**Document:** `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`  
**Tasks:** T-08, T-13  
**Session:** restart  
**Wait for:** W1: T-06 complete; W3: T-10 complete  

**Instruction:** You are **W1** for **Wave 3**. Open the taskspec at the path above and complete tasks **T-08, T-13** by ID. Use the document as the only source. Start a **new session** for this assignment.

---

### W2 — Wave 3

**Role:** Worker 2 (W2)  
**Wave:** Wave 3  
**Document:** `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`  
**Tasks:** T-09, T-14, T-15, T-16  
**Session:** inherit  
**Wait for:** W2: T-03, T-05 complete  

**Instruction:** You are **W2** for **Wave 3**. Open the taskspec at the path above and complete tasks **T-09, T-14, T-15, T-16** by ID. Use the document as the only source. **Continue in the same session/context** as your previous W2 assignment (inherit context).

---

### W3 — Wave 3

**Role:** Worker 3 (W3)  
**Wave:** Wave 3  
**Document:** `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`  
**Tasks:** T-12  
**Session:** restart  
**Wait for:** W3: T-10 complete; W2: T-11 complete  

**Instruction:** You are **W3** for **Wave 3**. Open the taskspec at the path above and complete task **T-12** by ID. Use the document as the only source. Start a **new session** for this assignment.

---

## Wave 4 (Phase 3)

Wave 4 starts only after **all P1 tasks are complete** (including Wave 3).

### W4 — Wave 4

**Role:** Worker 4 (W4)  
**Wave:** Wave 4  
**Document:** `/Users/yzliu/work/Meridian/v2.0.0/meridian_v2_taskspec.docx`  
**Tasks:** T-17  
**Session:** restart  
**Wait for:** All P1 tasks complete (Wave 1–3 done)  

**Instruction:** You are **W4** for **Wave 4**. Open the taskspec at the path above and complete task **T-17** by ID. Use the document as the only source. Start a **new session** for this assignment.

---

## Summary

| Wave | Worker | Tasks        | Session  | Wait for                          |
|------|--------|-------------|----------|-----------------------------------|
| 3    | W1     | T-08, T-13  | restart  | W1: T-06; W3: T-10                |
| 3    | W2     | T-09–T-16   | inherit  | W2: T-03, T-05                    |
| 3    | W3     | T-12        | restart  | W3: T-10; W2: T-11                |
| 4    | W4     | T-17        | restart  | All P1 complete                   |

Within Wave 3, W1 / W2 / W3 can run in parallel once their respective “Wait for” conditions are met.
