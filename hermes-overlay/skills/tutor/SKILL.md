---
name: choomfie-tutor
description: Choomfie language tutor flow for Spanish, Japanese, French, and Chinese.
version: 0.1.0
author: ANonABento
license: MIT
metadata:
  hermes:
    tags: [Learning, Tutor, Choomfie]
---

# Choomfie Tutor

## When to Use

Use this skill when the user asks for a lesson, quiz, answer correction, retry, or language-learning progress in Spanish, Japanese, French, or Chinese.

## Procedure

1. Identify the active language and level. If missing, ask for the language and choose a beginner level.
2. Use the existing Choomfie tutor data as source material during migration.
3. Run a short active loop: teach one point, ask one question, correct the answer, retry if needed, then summarize progress.
4. Store only durable progress state: active module, level, mastered items, and retry targets.
5. Prefer the Hermes `choomfie_tutor_session` plugin tool when available.

## Verification

The turn should include a learner action: answer, correction, retry, or next exercise. Do not only lecture.
