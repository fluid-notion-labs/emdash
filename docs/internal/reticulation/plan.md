# Reticulation Garden Doctor — Domain & Tooling Plan

> Context: Lee's one-man Perth reticulation install business.
> Site is being rebuilt on emdash (Astro + Cloudflare Workers + D1).
> TypeScript throughout.
>
> Two layers:
>   - **Phase 1**: parts catalogue / BOM tool for Lee's site (immediate need)
>   - **Ongoing**: YAML schema-first tooling experiment — the retic site is the first user
>
> The retic site is the test bed; the schema language is the experiment.

---

## The experiment

> What does a good "single source of truth schema" look like for the
> agent-and-human-collaboration era?

A declarative schema that drives:

- TypeScript types + Zod validation schemas
- emdash collection registration (via API seed script)
- SQL-level types for Kysely (where we bypass emdash)
- Markdown documentation
- *Eventually*: Rust structs, JSON Schema for API contracts

If after the retic site this earns its keep → `fluid-notion-labs/schemata`.
If not → delete it, keep the generated code.

---

## Format: strict-subset YAML

YAML 1.2 core schema, narrow subset:

**Use:** block mappings/sequences, inline flow for single-line leaf fields only,
`|` for multiline strings, `#` comments, quoted strings for all string scalars.

**Avoid:** implicit typing (Norway problem), anchors/aliases, multi-doc files,
tags, nested flow style.

Validated by `domain.schema.json` (JSON Schema) — gives editor autocomplete
and red squiggles. Zero parser code to maintain.

---

## Key finding: emdash schema is runtime, not static

**Investigation result:** emdash does not use a static `content.config.ts`.
Collections and fields are stored in D1 at runtime, managed via the admin UI
or API. The relevant tables are `_emdash_collections` and `_emdash_fields`.

When a collection is created, emdash also runs DDL to create a separate
`_content_{slug}` table for that collection's entries. This means we
**cannot** seed collections via raw SQL inserts — the content tables would
never get created.

**Consequence:** the codegen target for emdash is a **seed script** that
calls emdash's collection/field API after deploy, not a generated TS file.

```
domain.yaml
    ↓ codegen
src/domain/types.ts          ← TS interfaces + enums
src/domain/schemas.ts        ← Zod schemas
src/domain/fns.ts            ← computed field stubs (hand-written bodies)
src/domain/formulas.ts       ← formula registry (entirely hand-written)
scripts/seed-collections.ts  ← calls emdash API to register collections
```

The seed script is idempotent — checks if a collection exists before
creating it. Safe to run on redeploy.

---

## emdash field type mapping

emdash's `FieldType` covers everything we need:

| domain.yaml type | emdash FieldType | SQLite column |
|---|---|---|
| `string` | `string` | TEXT |
| `text` | `text` | TEXT |
| `integer` | `integer` | INTEGER |
| `number` | `number` | REAL |
| `boolean` | `boolean` | INTEGER |
| `datetime` | `datetime` | TEXT |
| `select` (enum) | `select` | TEXT |
| `url` | `url` | TEXT |
| `slug` | `slug` | TEXT |
| `ref: Foo` | `reference` + `options.collection` | TEXT |
| `money` | `integer` (cents) | INTEGER |

**Gaps:**
- No compound unique indexes — emdash only supports `unique: boolean` per
  field. `SupplierProduct(supplierId, productId)` uniqueness enforced at
  app layer only.
- No native `money` type — maps to `integer` (cents). Fine for phase 1.
- Self-referential refs (`ProductCategory.parentId`) work via
  `reference` + `options.collection: "product-categories"`.

---

## Schema: no function bodies

Computed fields reference TS function names. Bodies are hand-written:

```yaml
SupplierProduct:
  fields:
    unitPriceCents: { type: "integer" }
    tradePriceCents: { type: "integer", required: false }
  computed:
    effectivePriceCents:
      type: "number"
      fn: "supplierProductEffectivePrice"
```

Codegen emits a typed stub in `fns.ts` on first run, leaves it alone after.

---

## Domain model (phase 1)

### Enums
- `HeadType`: Rotary | Fixed | MicroSpray | Drip | Subsurface
- `SupplierType`: Wholesaler | Retailer | Online | DirectManufacturer
- `Unit`: Each | Metre | Roll | Bag | Box | Litre

### Value types (not persisted as collections)
- `FlowRate` — `{ lpm: number }`
- `WaterPressure` — `{ kpa: number }`

### Entities (persisted as emdash collections)

**ProductCategory** — hierarchical via `parentId` self-ref.

**Product** — brand+model specific part (e.g. "Hunter PGP-ADJ").
Computed: `coverageAreaM2` (π r²).

**Supplier** — Reece, WA Retic Supplies, Nutrien Water, Holman Direct.

**SupplierProduct** — supplier's variant: their SKU, price, stock status.
Price in integer cents. Computed: `effectivePriceCents`.

**JobTemplate** — reusable install pattern.

**JobTemplateLine** — product + `quantityFormulaId` (key into formula registry).

**BillOfMaterials** — concrete parts list for a job.

**BOMLine** — resolved product + quantity + price snapshot.
Snapshot rule: `unitPriceSnapshotCents` set at BOM creation, never changes.

---

## Formulas

`quantityFormulaId` is a key into a hand-written typed registry:

```ts
// src/domain/formulas.ts
export const formulas = {
  headsForArea: ({ areaM2, coverageM2 }: { areaM2: number; coverageM2: number }) =>
    Math.ceil(areaM2 / coverageM2),
  pipeWithSlack: ({ runM }: { runM: number }) => runM * 1.1,
  fixedQty: ({ qty }: { qty: number }) => qty,
} as const;

export type FormulaId = keyof typeof formulas;
```

No string eval, no parser. Real types, autocomplete, testable.

---

## Money

Integer cents throughout. No `decimal.js` in phase 1.
Field names are explicit: `unitPriceCents`, `tradePriceCents` etc.
If tax/invoicing lands later, swap codegen mapping — schema stays the same.

---

## Codegen

### Source
- `domain.yaml` — the schema
- `domain.schema.json` — JSON Schema for editor validation

### Tool
`scripts/codegen.ts` — tsx script. Reads YAML (`yaml` package), validates
(`ajv`), emits via template strings. No codegen framework.

### Outputs

| File | Generated? | Notes |
|---|---|---|
| `src/domain/types.ts` | Yes | TS interfaces, enums, value types |
| `src/domain/schemas.ts` | Yes | Zod schemas |
| `scripts/seed-collections.ts` | Yes | emdash API seed script |
| `src/domain/fns.ts` | Stubs only | Bodies hand-written; codegen won't overwrite |
| `src/domain/formulas.ts` | No | Entirely hand-written |
| `docs/domain.md` | Yes | Markdown doc + Mermaid ER diagram |

### Type mapping

| Schema | TypeScript |
|---|---|
| `string` / `text` / `url` / `slug` | `string` |
| `boolean` | `boolean` |
| `integer` / `number` / `money` | `number` |
| `datetime` | `string` (ISO 8601) |
| `select` | union of variant strings |
| `ref: Foo` | `string` (branded `FooId`) |
| `required: false` | `T \| null` |

---

## File layout

```
reticulationgardendoctor/
├── domain.yaml                    ← source of truth
├── domain.schema.json             ← JSON Schema for IDE validation
├── scripts/
│   ├── codegen.ts                 ← emits types, zod, seed script, docs
│   └── seed-collections.ts        ← generated; calls emdash API post-deploy
├── src/
│   └── domain/
│       ├── types.ts               ← generated
│       ├── schemas.ts             ← generated
│       ├── fns.ts                 ← stubs generated; bodies hand-written
│       └── formulas.ts            ← hand-written formula registry
├── docs/
│   └── domain.md                  ← generated docs + ER diagram
└── package.json
    # scripts: { "codegen": "tsx scripts/codegen.ts" }
```

---

## Deferred phases

- **Phase 2** — Quote builder: Customer/Lead, Quote, QuoteLine, contact form → email
- **Phase 3** — Procurement: PurchaseOrder, supplier ordering, receipts
- **Phase 4** — Logistics: multi-stop day planning, locality clusters

Each phase adds entities to `domain.yaml`. Codegen pipeline unchanged.

---

## Remaining open questions

1. **Seed script auth.** The seed script calls emdash's collection API — it
   needs auth. Options: (a) run against local dev instance with no auth,
   (b) use an emdash admin API token stored in `.dev.vars`. Which is the
   right model for a deploy-time seed?

2. **Codegen idempotency for `fns.ts`.** When a new `computed:` is added,
   codegen adds a stub without clobbering existing bodies. Two-file approach
   (`fns.generated.ts` + hand-written `fns.ts` re-exporting overrides) vs
   AST merge. Lean toward two-file for now — simpler, no AST dep.

3. **emdash `slug` field collision.** emdash has a reserved `slug` field on
   all collections. `ProductCategory` wants a user-defined slug. Need to
   verify whether emdash's built-in slug suffices or if naming conflicts with
   `RESERVED_FIELD_SLUGS`.

4. **Lee's actual parts list.** Without real seed data the catalogue is empty.
   Need: brands, specific model numbers, categories, at least one supplier
   with prices. Even a rough list is enough to start.

5. **Long-term schema repo.** If this works: `fluid-notion-labs/schemata`
   with `packages/parser`, `packages/codegen-ts`, `packages/codegen-emdash`.
   Retic site depends on it as a dev dep. In-tree until shape settles.
