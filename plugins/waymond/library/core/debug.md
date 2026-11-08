# Core — debug
- **Reproduce the bug reliably before you change any code.** Reason: if you can't reproduce it, you can't confirm the fix. https://www.debuggingbook.org/html/Intro_Debugging.html (Zeller, *The Debugging Book*), https://www.chiark.greenend.org.uk/~sgtatham/bugs.html
- **Reduce the reproduction to a minimal failing test, and commit it with the fix.** Reason: a small case isolates the cause, and the committed test stops regressions. https://www.debuggingbook.org/html/DeltaDebugger.html
- **Bisect history (`git bisect run <test>`) when the bug used to work.** Reason: binary search needs only log₂N steps. https://git-scm.com/docs/git-bisect
- **Form one hypothesis, test it, and record the result; change one variable at a time.** Reason: if you change several things at once, you can't tell which one mattered. https://www.debuggingbook.org/html/Intro_Debugging.html (scientific method)
- **Read the full error and stack trace before forming a hypothesis.** Reason: the first frame in your own code is usually where the fault is. https://docs.python.org/3/library/traceback.html
