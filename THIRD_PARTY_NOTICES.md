# Third-party code and references

Checked on 2026-11-18 against the exact commits below. The kick-off deck sets no
specific rule on code reuse; it asks for a working Docker build, secure handling
of API keys, mock or synthetic data, and a README. Reuse is documented here so
reviewers can verify it.

| Project | Commit checked | License at that commit | What TwinSync uses | Where |
|---|---|---|---|---|
| [OpenSelf](https://github.com/Open-Self/Open-Self) | `f0650e302615f368fb769cb949e0f9bf3b4953ee` | MIT (`LICENSE`, `package.json`) | **Code, unmodified:** `src/context/schema.js`, the memory record schema (`normalizeMemory`, memory types, source locator, the `untrusted → external → trusted → verified → owner` trust ladder, `contentHash`). | `server/vendor/openself/schema.js` + `LICENSE`; adapter written by the team: `server/memory.ts` (every memory item gets an OpenSelf record stamp) |
| [agent_mesh](https://github.com/iamanirbanbasak/agent_mesh) | `51bfb33910882ab9962e463efebb294317b52c26` | README says "MIT — see LICENSE", but **there is no LICENSE file in the repo at that commit** | **No code copied.** Only the group-negotiation rules from `backend/features/trip.py` (`run_group_negotiation`): budget ceiling = lowest budget, accept ≥ 65 / counter 40–64 / escalate < 40, every participant keeps at least one preference. Re-implemented by the team as deterministic code. | `shared/decide.ts` (`STANCE_THRESHOLDS`, `decide`) |
| [Nolmi](https://github.com/nolmi-ai/nolmi) | `52bb8b534f8caa2faedff37aa852f34cf30c1ce9` | AGPL-3.0-only | **No code imported.** Used only as an architecture reference for twin-to-twin communication, and in particular for its principle that the owner approves each interaction between twins. | see README → Architecture |

## Why only these parts

- **OpenSelf.** The schema is a single 95-line module whose only dependencies are `zod` and `node:crypto`. Probed with our own input (Giorgos' synthetic budget note), it produced a valid record with a stable hash and rejected an unknown memory type. That makes it the smallest piece that actually works. The rest of OpenSelf (SQLite vault, MCP server, CLI) is far larger than a hackathon demo needs.
- **agent_mesh.** We probed `TripFeature.get_context` with our three profiles, stubbing out the external tools. It only supports two participants (A/B), has no return-time constraint, and hardcodes currency (₹) and origin (Mumbai). The proposal itself is produced and scored by an LLM (Gemini) through a Telegram/SQLite pipeline. It could not check our mandatory constraints in code or run in our Node stack, so we kept the rules and wrote the logic ourselves.
- **Nolmi.** Under AGPL-3.0-only, importing its code would impose AGPL obligations on the whole service, and this assignment excludes importing it. TwinSync follows the idea instead: twins exchange structured positions (scores, reasons with memory ids), never free-form messages, and nothing is final without each owner's approval.

## npm dependencies

Runtime: `express` (MIT), `zod` (MIT), `openai` (Apache-2.0), `@anthropic-ai/sdk` (MIT). UI: `react`, `react-dom` (MIT), `lucide-react` icons (ISC), `fflate` for reading the questionnaire ZIP in the browser (MIT). Build and dev: `vite`, `@vitejs/plugin-react`, `esbuild`, `typescript`, `tsx`, `vitest`, all under MIT or Apache-2.0. See `package-lock.json` for the full tree.
