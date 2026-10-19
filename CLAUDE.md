# Stills service: notes for Claude

Read README.md and docs/ARCHITECTURE.md first. The brief this was built from lives in the Production Engine repo: docs/STILLS-SERVICE-BRIEF.md.

Rules:
- British English, plain and short, in code comments, docs and UI text.
- London only (eu-west-2) for files and data.
- No face analysis of any kind (no Rekognition faces, no eyes-closed or smile scores). Face matching stays in Happened.
- AI-made stills: always flagged and labelled, never chosen automatically. Paid AI (Higgsfield or any other): estimate the cost and get Steve's OK first.
- Never put keys or passwords in code, commits or chat. Use Secrets Manager.
- Commit before deploying. Don't commit or push unless Steve asks.

Working here:
- The adjustment maths lives in packages/recipe and must stay dependency-free: the editor and the server both run it. If you change it, keep the "preview matches the result" test passing.
- `npm test` runs everything against in-memory AWS fakes (services/test/fakes.ts). Add expression support there if you use new DynamoDB expressions.
- `npm run synth` must stay clean (no circular dependencies).
