# Reticulation Garden Doctor — Domain & Tooling Plan

> Context: Lee's one-man Perth reticulation install business.
> Site is being rebuilt on emdash (Astro + Cloudflare Workers + D1).
> TypeScript throughout.
>
> This plan has two layers:
>   - **Phase 1**: a parts catalogue / BOM tool for Lee's site (the immediate need)
>   - **Phase 0**: a schema-first tooling experiment that the retic site is the first user of (the long-term interest)
>
> The retic site is the test bed; the schema language is the experiment.

---

## The experiment

> What does a good "single source of truth schema" format look like for the
> agent-and-human-collaboration era?

A declarative schema that drives:

- TypeScript types
- Zod validation schemas
- emdash content type config (so Lee's site uses emdash's admin UI)
- SQL migrations for D1
- Markdown documentation
- *Eventually*: Rust structs for FluidX3D-adjacent work, JSON Schema for API contracts

If after one real use (the retic site) the format earns its keep, it becomes its
own repo (`fluid-notion-labs/schemata`). If it doesn't, we throw it away and the
retic site keeps the generated code.

---

## Format choice: strict-subset YAML

Rather than invent a new format with a custom parser, we use YAML 1.2 core
schema with a deliberately narrow subset:

**Use:**
- Block mappings and sequences (indentation hierarchy)
- Inline flow style for terse single-line leaf field definitions only
- `|` for multi-line preserved-newline strings (docs, notes)
- `#` comments
- Quoted strings everywhere a string is a string

**Do not use:**
- Implicit typing (the Norway problem) — quote all string scalars
- Anchors/aliases (`&` / `*`) — fragile, don't roundtrip well across editors
- Multi-document files (`---`) — one file = one document
- Tags (`!!python/object` etc.) — pure data only
- Flow style for nested structures

A `domain.schema.json` (JSON Schema) describes what `domain.yaml` may contain.
Editors give us autocomplete and validation for free via:

```jsonc
// .vscode/settings.json or equivalent
"yaml.schemas": {
  "./domain.schema.json": "domain.yaml"
}
```

This means **zero parser code to maintain** and we get to focus on the
interesting question: what does the schema vocabulary look like.

---

## What's in the schema

Data shape only. **No function bodies.** Computed behaviour lives in
hand-written TypeScript and is referenced by name from the schema:

```yaml
SupplierProduct:
  fields:
    unitPrice:   { type: "money" }
    tradePrice:  { type: "money", optional: true }
  computed:
    effectivePrice:
      type: "money"
      fn: "supplierProductEffectivePrice"   # name of TS function in src/domain/fns.ts
```

The codegen emits a typed function signature stub the first time it sees the
name. Subsequent runs leave the file alone if the function exists. The
schema *references* behaviour; it doesn't *define* it.

---

## Domain model (phase 1 scope)

Just the parts catalogue + BOM slice. Everything else (quoting, procurement,
logistics) is deferred and noted at the end.

### Enums

- `HeadType`: Rotary | Fixed | MicroSpray | Drip | Subsurface
- `SupplierType`: Wholesaler | Retailer | Online | DirectManufacturer

### Value types

- `FlowRate` — `{ lpm: f64 }`
- `WaterPressure` — `{ kpa: f64 }`

### Entities

**ProductCategory** — hierarchical (self-ref via `parentId`).
Fields: name, slug, parentId?.

**Product** — a part Lee uses (e.g. "Hunter PGP-ADJ").
Fields: name, sku, brand, categoryId, unit, description?, headType?,
radiusM?, flowRate?, isActive (default true).
Indexes: unique(sku), (categoryId).

**Supplier** — Reece, WA Retic Supplies, Nutrien Water, Holman Direct.
Fields: name, type, website?, notes?.

**SupplierProduct** — a supplier's variant of a product.
Fields: supplierId, productId, supplierSku, unitPrice, tradePrice?, inStock,
lastChecked?.
Indexes: unique(supplierId, productId).
Computed: `effectivePrice` → tradePrice ?? unitPrice.

**JobTemplate** — reusable install pattern (e.g. "Standard lawn zone").
Fields: name, description, notes?.

**JobTemplateLine** — one line in a template.
Fields: templateId, productId, description, quantityFormulaId, sortOrder.
`quantityFormulaId` is a **named function key**, not an expression string —
see "Formulas" below.

**BillOfMaterials** — a concrete parts list for a specific job.
Fields: name, siteAddress?, createdAt, notes?.

**BOMLine** — one resolved line.
Fields: bomId, productId, description, quantity, supplierProductId?,
unitPriceSnapshot, notes?.
Computed: `lineTotal` → quantity * unitPriceSnapshot.

**Snapshot rule:** `unitPriceSnapshot` is set at BOM creation time and never
changes. Even in phase 1, this matters — Lee needs to be able to reproduce
"what we quoted Mrs Smith last Tuesday."

---

## Formulas

`JobTemplateLine.quantityFormulaId` references a typed TypeScript function in
a registry, **not** a string expression evaluated at runtime:

```ts
// src/domain/formulas.ts
export const formulas = {
  headsForArea: ({ areaM2, coverageM2 }: { areaM2: number; coverageM2: number }) =>
    Math.ceil(areaM2 / coverageM2),

  pipeWithSlack: ({ runM }: { runM: number }) =>
    runM * 1.1,

  fixedQty: ({ qty }: { qty: number }) =>
    qty,
} as const;

export type FormulaId = keyof typeof formulas;
```

Schema then references by name:

```yaml
JobTemplateLine:
  fields:
    quantityFormulaId: { type: "FormulaId" }   # codegen emits as keyof typeof formulas
```

Real types, autocomplete, tests, no parser, no eval. The schema doesn't need
to know what a formula contains, only that it's a key into the registry.

---

## Money type

Phase 1: **integer cents**. No `decimal.js`. Sufficient for Lee's scale,
zero bundle cost, no floating-point traps.

```yaml
unitPrice: { type: "money" }   # codegen: number (cents)
```

If/when invoicing or tax handling lands, swap to a decimal type. The schema
field type stays `money`; only the codegen mapping changes.

---

## Codegen

### Source files

- `domain.yaml` — the schema (one file, one document)
- `domain.schema.json` — JSON Schema for editor validation of `domain.yaml`

### Tool

`scripts/codegen.ts` — Node script run via `tsx`. Reads YAML with the `yaml`
package, validates with `ajv`, emits TS files via template strings. No
codegen framework.

### Outputs

| File | Contents | Hand-edit? |
|---|---|---|
| `src/domain/types.ts` | TS interfaces, enums, value types, FormulaId | No (regenerated) |
| `src/domain/schemas.ts` | Zod schemas per entity | No (regenerated) |
| `src/content.config.ts` | emdash content type definitions | No (regenerated) |
| `migrations/NNNN_*.sql` | Schema diffs (manual review before applying) | Yes (review/rename) |
| `src/domain/fns.ts` | Function stubs for `computed` references — only emitted if not present | Yes (write bodies) |
| `src/domain/formulas.ts` | Formula registry | Yes (entirely hand-written) |
| `docs/domain.md` | Human-readable schema doc with Mermaid ER diagram | No (regenerated) |

### Type mapping

| Schema | TypeScript |
|---|---|
| `string` | `string` |
| `bool` | `boolean` |
| `f64` / `i32` / `u32` | `number` |
| `uuid` | `string` (branded `Uuid`) |
| `date` | `string` (ISO 8601) |
| `datetime` | `string` (ISO 8601) |
| `money` | `number` (integer cents) |
| `optional: true` | `T \| null` |
| `ref: Foo` | `FooId` (branded uuid) |

---

## emdash interop

The codegen emits `src/content.config.ts` in emdash's content type format
(once we've inspected what that format actually is — gating investigation
before any code is written).

Lee gets:
- emdash's admin React SPA for free
- TipTap editor for description fields
- Validation for free (Zod schemas wired in)
- Migrations, drafts, revisions handled by emdash

Computed logic (`effectivePrice`, BOM derivation from JobTemplate) is plain
TS imported by emdash hooks/server functions.

If emdash's content type format can't express something the schema needs
(e.g. compound unique indexes, self-referential FKs), we either:
1. Adjust the schema to fit emdash's capabilities, or
2. Bypass emdash for that specific entity and hand-roll D1 access via Kysely

Decision is per-entity, not global.

---

## File layout

```
reticulationgardendoctor/
├── domain.yaml                  ← source of truth (the schema)
├── domain.schema.json           ← JSON Schema for IDE validation of domain.yaml
├── codegen.config.yaml          ← codegen targets / type map
├── scripts/
│   └── codegen.ts               ← reads domain.yaml, emits everything
├── src/
│   ├── content.config.ts        ← generated (emdash collections)
│   └── domain/
│       ├── types.ts             ← generated
│       ├── schemas.ts           ← generated (Zod)
│       ├── fns.ts               ← stubs generated, bodies hand-written
│       └── formulas.ts          ← entirely hand-written
├── migrations/
│   └── 0001_init.sql            ← generated, reviewed before commit
└── package.json
    # add: "codegen": "tsx scripts/codegen.ts"
```

---

## What's deferred

Phase 1 is parts catalogue + BOM only. The earlier broader scope (preserved
in `domain.full.toml` for reference) covers:

- **Phase 2** — Quote builder. Customer/Lead, Quote, QuoteLine, contact form
- **Phase 3** — Procurement. PurchaseOrder, supplier ordering, receipts
- **Phase 4** — Job scheduling + logistics. Multi-stop day planning, locality clusters

Each phase adds entities to `domain.yaml` and lets the existing codegen
pipeline pick them up. No tooling changes expected per phase.

---

## Investigation gate (do these before writing code)

1. **Read `packages/core/src/content/`** in the emdash repo — figure out the
   exact content type definition format. This determines what `codegen-emdash`
   has to emit and whether some schema features need to bend to fit.

2. **Read the plugin RFC on `wip/plugin-rfc`** — see if this should be
   structured as an emdash plugin rather than just a sibling module.

3. **Get Lee's actual parts list.** The schema can be designed in the
   abstract, but seed data needs the specific brands/SKUs Lee uses. Without
   this, the catalogue has nothing to populate it with.

---

## Open questions (after investigation)

1. **Snapshot enforcement.** Should `BOMLine.unitPriceSnapshot` be enforced
   immutable at the DB layer (trigger/CHECK constraint), or only at the
   application layer? Cheaper at the app layer; more correct at the DB.

2. **emdash content type expressiveness.** Once we've read emdash's content
   config format: can it express the SupplierProduct join with compound
   unique index? If not, we go around it for that one table.

3. **Schema versioning.** Should `domain.yaml` carry a `version: "0.1.0"`
   field that gates migration generation, or is git history sufficient?
   Probably git for now; revisit if/when there are multiple deployed copies.

4. **Codegen idempotency for `fns.ts`.** When a `computed:` is added to the
   schema, the codegen needs to add a stub to `fns.ts` *without* clobbering
   existing stubs. Implementation choice: parse `fns.ts` AST and merge, or
   maintain a separate `fns.generated.ts` plus a hand-written `fns.ts` that
   re-exports overrides? AST merge is more elegant; two-file approach is
   simpler and probably correct.

5. **Where the schema language lives long-term.** If this works, it becomes
   `fluid-notion-labs/schemata` — a separate repo with the parser (well, just
   a YAML loader + JSON Schema validator), the codegen targets as separate
   packages, and a real format spec doc. The retic site then depends on it.
   For now keep it in-tree until the shape settles.

---

## Why this, vs just using emdash directly

A reasonable critique: emdash already does collections, schemas, validation,
admin UI. Why a separate schema layer at all?

**Answer:** because the long-term experiment is *not* about Lee's site. It's
about whether a single declarative schema can drive multiple targets across
multiple language ecosystems. emdash is the *first target*, not the source.

If we just used emdash's content config as the source of truth, we'd lock
ourselves to TS and to emdash's content-shape vocabulary forever. The cost of
a thin schema layer on top is low; the cost of not having one and wanting it
later is rewriting all the content config.

If after building Lee's site this layer feels like dead weight, we delete it
and keep the emdash configs. Cheap experiment.
