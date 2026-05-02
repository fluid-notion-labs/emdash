# Reticulation Garden Doctor — Domain & Tooling Plan

> For review by Opus. Context: Lee's one-man Perth reticulation install business.
> Site is being rebuilt on emdash (Astro + Cloudflare Workers + D1).
> TypeScript throughout. No Rust.

---

## What we're building (phase 1)

A parts catalogue and bill-of-materials tool embedded in the emdash site.
The goal is: given a job (e.g. "3-zone residential lawn"), produce a parts list
with quantities and supplier info. Not a full ERP — just what Lee needs on the job.

---

## Domain model (trimmed)

Defined in `domain.toml`, source of truth for codegen.

### Entities

**ProductCategory**
Hierarchical. e.g. Heads > Rotary, Pipe & Fittings, Valves, Controllers, Wire.

**Product**
A part Lee actually uses. Brand + model specific (e.g. "Hunter PGP-ADJ").
Fields: name, sku, category, brand, unit (each/m/roll), description,
head_type?, radius_m?, flow_rate_lpm?, is_active.

**Supplier**
Where Lee buys from. e.g. Reece, WA Retic Supplies, Nutrien Water, Holman Direct.
Fields: name, type (wholesaler/retailer), website, notes.

**SupplierProduct**
A supplier's variant of a product — their SKU, trade price, availability.
Fields: supplier_id, product_id, supplier_sku, unit_price, trade_price?,
in_stock, last_checked?.
Function: `effectivePrice()` → trade_price ?? unit_price.

**JobTemplate**
A reusable install pattern. e.g. "Standard lawn zone", "Drip garden zone".
Fields: name, description, notes.

**JobTemplateLine**
One line in a template — a product + quantity formula.
Fields: template_id, product_id, description, quantity_formula (string),
sort_order.
The formula is a simple expression evaluated against job inputs:
e.g. `"ceil(area_m2 / head_coverage_m2)"` or `"pipe_run_m * 1.1"`.

**BillOfMaterials**
A concrete parts list for a specific job, derived from a template
plus measured site inputs (area, pipe runs, zone count etc.).
Fields: name, site_address?, created_at, notes.

**BOMLine**
One line of a BOM — resolved product + quantity + supplier selection.
Fields: bom_id, product_id, description, quantity, supplier_product_id?,
unit_price_snapshot?, notes.
Function: `lineTotal()` → quantity * unit_price_snapshot.

### Value types

**FlowRate** — lpm: f64. Methods: lph().
**WaterPressure** — kpa: f64. Methods: psi(), isLow(), isHigh().

### Enums

HeadType: Rotary | Fixed | MicroSpray | Drip | Subsurface
SupplierType: Wholesaler | Retailer | Online | DirectManufacturer

---

## Codegen

Source: `domain.toml`
Tool: `scripts/codegen.ts` — a Node script (tsx), reads TOML, emits TS files.
No external codegen framework — straightforward template strings.

### Outputs

| File | Contents |
|------|----------|
| `src/domain/types.ts` | TypeScript interfaces for all entities, value types, enums |
| `src/domain/schemas.ts` | Zod schemas — one per entity, used for form validation and API parsing |
| `src/domain/db.ts` | Kysely table type definitions for D1 |
| `src/domain/fns.ts` | Function stubs from domain.toml — typed, with `// TODO` bodies |

### Function stub format (domain.toml → TS)

```toml
[[entity.fn]]
name = "effectivePrice"
signature = "(): Money"
body = "return this.tradePrice ?? this.unitPrice"
```

Emits in `fns.ts`:
```ts
// SupplierProduct
export function supplierProductEffectivePrice(self: SupplierProduct): Money {
  return self.tradePrice ?? self.unitPrice;
}
```

Plain functions over `self` parameter — not class methods. Keeps it compatible
with Kysely rows (plain objects) without a hydration step.

### Type mapping

| domain.toml | TypeScript |
|-------------|------------|
| string | string |
| bool | boolean |
| f64 / i32 / u32 | number |
| uuid | string (branded: `type Uuid = string & { __uuid: true }`) |
| date | string (ISO 8601 date) |
| datetime | string (ISO 8601 datetime) |
| money | Decimal (from `decimal.js`) |
| Option\<T\> | T \| null |
| Vec\<T\> | T[] |
| ref:\<Entity\> | EntityId (branded uuid) |

### Zod schema conventions

- money fields → `z.string()` then parsed to Decimal (avoids float loss)
- uuid fields → `z.string().uuid()`
- Optional fields → `.nullable()`
- Enums → `z.enum([...])` from domain.toml variants

---

## File layout

```
reticulationgardendoctor/   (emdash site repo)
├── domain.toml             ← source of truth
├── codegen.toml            ← codegen config (targets, type map)
├── scripts/
│   └── codegen.ts          ← the codegen script (tsx)
├── src/
│   └── domain/
│       ├── types.ts         ← generated
│       ├── schemas.ts       ← generated
│       ├── db.ts            ← generated
│       └── fns.ts           ← generated (stubs; real impls written here)
└── package.json
    # add: "codegen": "tsx scripts/codegen.ts"
```

---

## What's deferred

The original domain.toml had a much broader scope — quoting, procurement,
logistics, job scheduling, locality clustering. All of that is valid for later
phases but not needed for the parts catalogue tool. It's preserved in
`domain.full.toml` for reference.

Future phases roughly:
- Phase 2: Quote builder (QuoteLine, customer contact form → email to Lee)
- Phase 3: Procurement (PurchaseOrder, SupplierOrder, receipt tracking)
- Phase 4: Job scheduling + logistics (multi-stop day planning, locality clusters)

---

## Open questions for Opus

1. **quantity_formula** — simple string expression evaluated at runtime (e.g.
   `ceil(area_m2 / head_coverage_m2)`) vs. a structured formula type in TOML?
   String is flexible but opaque. Structured (operator + operands) is verbose
   but statically analysable. Which is better here?

2. **BOMLine.unit_price_snapshot** — snapshotting supplier price at BOM
   creation time makes sense for quoting, but for a simple parts list Lee
   might just want live prices. Should the BOM model care about price at all
   in phase 1, or just quantities?

3. **money type** — `decimal.js` in the browser/worker is fine but adds a dep.
   For phase 1 (parts list, no invoicing), is plain `number` (cents as integer)
   acceptable? Simpler, no dep, sufficient for display.

4. **domain.toml fn bodies in TS** — the TOML embeds short function bodies as
   strings. Is this a good pattern or should the TOML only define signatures
   and the bodies always live in hand-written `fns.ts`? Bodies in TOML are
   convenient for trivial computed fields but feel wrong for anything non-trivial.

5. **Kysely vs raw D1 queries for phase 1** — emdash uses Kysely internally.
   Should the parts catalogue use Kysely too (consistency) or just raw
   `env.DB.prepare()` calls (simpler, fewer abstractions for a small catalogue)?
