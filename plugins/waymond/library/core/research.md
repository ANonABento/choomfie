# Core — research
- Cite a primary source URL (official docs, spec, source code, paper) for every non-obvious claim. Skip SEO listicles. Reason: it keeps answers auditable. https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- Check each claim against a supporting quote. If none exists, retract the claim or mark it unverified. Same URL.
- Say "I don't know" or "unknown" rather than guess. Explicitly allowing this reduces hallucination. Same URL.
- For long sources (>20K tokens), pull word-for-word quotes first, then reason only from those quotes. Same URL.
- Record the version and access date for each source. When sources disagree, name the one you trust and why. Reason: plan.md Risks section says "cite page + access date".
- Tag every snippet or command `tested` or `untested`. Only call it `tested` if it was actually run (plan.md req. 5).
