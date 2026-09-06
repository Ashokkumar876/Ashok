---
name: custom-rule-engine-reference
description: "Self-contained reference for writing DRL custom rule scripts for this cabinet/furniture design rule engine (FParamModel/FCustomModel object model, BaseDirect axis convention, offset-based movement detection, violation reporting, upload/script-structure rules). Use whenever writing, reviewing, or debugging a .drl custom rule script for this platform and MCP access to the custom-rule-assistant tool is not available."
---

# Custom Rule Engine Reference (no-MCP)

This is a static knowledge reference for this platform's Drools-based custom rule
engine, extracted and confirmed via the `custom-rule-assistant` MCP tool on
2026-09-03, plus one field-tested finding added 2026-09-06 (see section 9). Use it
to write `.drl` rule scripts directly, without needing MCP access.

It covers only what was explicitly confirmed. If you need something not listed here
and have no MCP access, say so explicitly rather than guessing — a guessed method
name is a common cause of upload failures.

## 1. Script structure (upload requirements)

- **Do NOT write `package`, `import`, or `global` declarations.** The upload
  platform auto-injects its own preamble (package + standard imports + globals)
  before your script content. Adding your own causes a duplicate declaration.
- Only write `rule "..." when ... then ... end` blocks (and optionally
  `function ... { }` helper blocks — `function`/`rule`/`query` are accepted top-level
  tokens).
- **ERROR 107** (`mismatched input 'package' ...`, "Parser returned a null Package")
  means the pre-check/parse step failed — almost always caused by a hand-written
  `package` line, or another syntax error (unbalanced braces, missing semicolons,
  undefined variables).
- The web upload UI (Homworks Studio "Rule Detection" screen) parses a pasted
  multi-rule script into separate structured "paragraph" blocks (one per `rule`),
  each with its own editable `when`/`then` fields. It does **not** appear to give a
  place for standalone top-level `function ... { }` blocks pasted alongside rules —
  if you paste helper functions above/between rules, they may be silently dropped
  rather than attached anywhere, leaving calls to them undefined. Prefer inlining
  logic directly in each rule's `then` block over relying on shared `function`
  blocks with this particular upload UI, unless you've confirmed where a function
  block should go.

## 2. Core object model (confirmed methods)

Primary working type in rule conditions: `FParamModel` (extends `FCustomModel`).

| Method | Returns | Meaning |
|---|---|---|
| `getName()` | `String` | Model's display name |
| `getPosition()` | `Float3 {x,y,z}` | Current position **relative to parent** (mm) |
| `getAbsPosition()` | `Float3 {x,y,z}` | Current position in **world/absolute** coordinates (mm) |
| `getRotateDegree()` | `Float3 {x,y,z}` | Rotation angle around each axis |
| `getParent()` | model | Parent node in the model tree |
| `getSubModels()` | list | Direct children |
| `getRoot()` / `getRootOrMainModel()` | model | Top-level ancestor |
| `getMain()` | model | The **host model this component was added to** (NOT an "original/template" reference — do not use it to recover a pre-move position) |
| `isRootModel()` | `boolean` | `parent == null` |
| `isOriginComponent()` | `boolean` | `main == null && parent != null` — native (non-added) component |
| `isOrigin()` | `boolean` | Vendor-specific flag, **not general-purpose** — avoid unless you know the specific vendor logic it encodes |
| `hasAddition()` | `boolean` | Whether the model has added (non-native) sub-components |
| `getBrandGood()` | `FBrandGood` | The linked catalog/goods object |
| `getAllParameter()` | `List<FParameter>` | **All** parameters, including hidden/invisible ones |
| `getParameterByName(name)` | `FParameter` | Matches on either `name` or `simpleName`; returns `null` if not found — null-check before use |
| `getAbsoluteBoundingBox()` | `BoundingBox` | World-space AABB; `.getMin()`/`.getMax()` return `Float3`; `.intersects(other)` |
| `getSize()` | `Float3` | Model dimensions |

> **Unconfirmed:** whether `Float3` exposes `x`/`y`/`z` as public fields (`.x`) or
> getters (`.getX()`). The table notation `Float3 {x,y,z}` is descriptive shorthand
> from the MCP tool, not proof of accessor style. No confirmed example in this doc
> reads a `Float3`'s components directly. If a rule that does `.getMin().x` throws
> a syntax/compile error pointing at that line, try `.getMin().getX()` instead.

`FBrandGood` (via `$m.getBrandGood()` or property path `brandGood.xxx`):

| Field/getter | Meaning |
|---|---|
| `brandGoodName` / `getBrandGoodName()` | Item's display/catalog name — **use this for name-based matching**, e.g. Shelf vs Partition identification |
| `obsBrandGoodId` / `getObsBrandGoodId()` (same as `getBrandGoodId()`) | Encrypted goods id, e.g. `"3FO4GB98YDT4"` — **not** a name field |

> There is no confirmed field called `obsBrandgoodname`. If your business template
> genuinely has a differently-named field, confirm the exact spelling before using
> it — a typo here silently matches nothing and the rule never fires.

`FParameter` (from `getAllParameter()` / `getParameterByName()`):

| Method | Returns | Meaning |
|---|---|---|
| `getName()` | `String` | Parameter name — used in property constraints as `name == "..."` |
| `getType()` | `String` | Parameter type |
| `getValue()` | `String` | Raw string value |
| `getParsedValue(Class<T>)` | `T` | Typed value, e.g. `getParsedValue(Float.class)` |
| `getIgnored()` | `Boolean` | Whether hidden |
| `isVisible()` | `boolean` | Visibility flag |
| `getOptionValues()` | list | Available option values (for enum-like params) |

Property-path shorthand works in `when` conditions, e.g.:
```
$m: FParamModel(brandGood.brandGoodName != null && brandGood.brandGoodName.toLowerCase().contains("shelf"))
```

## 3. Axis convention

- **Units: millimeters (mm)** throughout (position, size, offsets).
- `BaseDirect` enum: `X_POSITIVE`/`X_NEGATIVE`, `Y_POSITIVE`/`Y_NEGATIVE`, `Z_POSITIVE`/`Z_NEGATIVE`.
- Confirmed semantic mapping:
  - **Z axis = up/down.** `Z_POSITIVE` = Up, `Z_NEGATIVE` = Down.
  - **X axis = left/right.**
  - **Y axis = front/back (depth).**
- **Important:** which *sign* (+/-) corresponds to "left" vs "right" or "front" vs
  "back" is **not globally fixed** — it depends on the individual model/cabinet's
  own orientation (rotation). `findModel(...)` resolves direction using the
  top-level model's orientation; `findModelUseModelAbsDirection(...)` uses the
  target model's own orientation instead. Don't hardcode "positive X = right" in
  a user-facing message — report the signed value and axis name instead (e.g.
  "left-right (X) offset: 12.5 mm"), and phrase corrections as "move it back by
  N mm along the [axis] axis" rather than asserting a specific direction word.

## 4. Detecting "has this moved from its original position?"

There is **no** snapshot API for a stored original/design-time position
(`getPosition()`/`getAbsPosition()` are current-value only; no
`getInitPosition()`/`getOriginPosition()`/`getParamPosition()` exists).

The confirmed working mechanism is the **`offset` parameter**:

- Fetch via: `$p: FParameter(name == "offset") from $m.getAllParameter()`
- `$p.getValue()` returns a comma-separated string `"x,y,z"` in mm.
- Default/unmoved value is `"0.0,0.0,0.0"`.
- A non-zero component on a given axis means the model has been dragged away
  from its original position on that axis. (Confirmed against a real production
  example rule, `hasOffset`, in the platform's knowledge base.)

Parsing pattern:
```java
String offsetStr = $p.getValue();
if (offsetStr != null && offsetStr.trim().length() > 0) {
    String[] val = offsetStr.split(",");
    float offsetX = Math.round(Float.parseFloat(val[0]) * 100) / 100.0f;
    float offsetY = Math.round(Float.parseFloat(val[1]) * 100) / 100.0f;
    float offsetZ = Math.round(Float.parseFloat(val[2]) * 100) / 100.0f;
    // compare offsetX/Y/Z != 0.0f as needed
}
```

> Caveat: the x/y/z ordering follows the standard `Float3` convention used
> everywhere else in this API, but wasn't independently re-confirmed for this
> specific parameter beyond the one example found. Sanity-check against a real
> dragged component before relying on it in production.

## 5. Reporting a rule violation

**Standard way** (what every example rule in the knowledge base uses — a
soft validation finding shown to the designer, does not abort other rules):
```java
_result.getList().add(createParamModelResult("your message here", $m));
// or with multiple related models:
_result.getList().add(createParamModelResult("your message here", $m1, $m2));
```

**Hard exception** (rare — for genuine script/data errors, not design warnings):
```java
throw new RuleServiceException(RULE_SYNTAX_ERROR, "message");
// or
throw ErrorResultEnum.INVALID_PARAM.exception();
```
For "designer did X wrong" style warnings, always prefer `createParamModelResult`
+ `_result.getList().add(...)`.

## 6. Adjacency / distance helpers (for structural checks, e.g. "still touching the side panel")

| Function | Notes |
|---|---|
| `sizeDistance(a, b, dir1, dir2)` | **Deprecated** — unreliable once a model is rotated off a 90° multiple. `dir1` = projection direction, `dir2` = measurement direction along the projected 2D plane. |
| `projectionDistanceV2(a, b, BaseDirect)` | Preferred replacement — accurate even when rotated. |
| `isModelAdjoin(a, b, tolerance)` | Boolean: true if bounding boxes are within `tolerance` of touching (real bbox). |
| `isModelAdjoinNotUseRealBox(a, b, tolerance)` | Same, using absolute bbox instead of real bbox. |
| `findModel(model, BaseDirect, modelTree)` | Finds neighboring models in a direction, using the **top-level model's** orientation. |
| `findModelUseModelAbsDirection(model, BaseDirect, modelTree)` | Same, using the **target model's own** orientation. |
| `correct(model, paramName, value, LockDirection)` / `.autoCorrect(...)` | Auto-fix helper attached to a result, e.g. `createParamModelResult(...).autoCorrect($m, "W", 300, LockDirection.LEFT)`. `LockDirection` enum: `LEFT, RIGHT, TOP, BOTTOM, FRONT, BACK, NONE`. |

> **Unconfirmed:** the exact signature/expected value of the `modelTree` parameter
> for `findModel`/`findModelUseModelAbsDirection` was never independently verified
> in this doc (no worked example calls them). Prefer the declarative
> `from $m.getParent().getSubModels()` pattern in section 9 for nearest-neighbor
> style checks unless you've confirmed what `modelTree` should be.

## 7. Worked example

Shelf may only move up/down; Partition may only move left/right; both identified
by a case-insensitive substring match on `brandGood.brandGoodName`.

```java
rule "Shelf must not move front/back or left/right"
when
    $m: FParamModel(brandGood != null && brandGood.brandGoodName != null &&
        brandGood.brandGoodName.toLowerCase().contains("shelf"))
    $p: FParameter(name == "offset") from $m.getAllParameter()
then
    String offsetStr = $p.getValue();
    if (offsetStr != null && offsetStr.trim().length() > 0) {
        String[] val = offsetStr.split(",");
        float offsetX = Math.round(Float.parseFloat(val[0]) * 100) / 100.0f;
        float offsetY = Math.round(Float.parseFloat(val[1]) * 100) / 100.0f;
        if (offsetX != 0.0f || offsetY != 0.0f) {
            StringBuilder msg = new StringBuilder();
            msg.append("[" + $m.getName() + "] Shelf is not in its original position, only up/down movement is allowed.");
            if (offsetX != 0.0f) {
                msg.append(" Left-right (X) offset: " + offsetX + " mm - move it back by " + Math.abs(offsetX) + " mm along the left-right axis.");
            }
            if (offsetY != 0.0f) {
                msg.append(" Front-back (Y) offset: " + offsetY + " mm - move it back by " + Math.abs(offsetY) + " mm along the front-back axis.");
            }
            _result.getList().add(createParamModelResult(msg.toString(), $m));
        }
    }
end

rule "Partition must not move up/down or front/back"
when
    $m: FParamModel(brandGood != null && brandGood.brandGoodName != null &&
        brandGood.brandGoodName.toLowerCase().contains("partition"))
    $p: FParameter(name == "offset") from $m.getAllParameter()
then
    String offsetStr = $p.getValue();
    if (offsetStr != null && offsetStr.trim().length() > 0) {
        String[] val = offsetStr.split(",");
        float offsetY = Math.round(Float.parseFloat(val[1]) * 100) / 100.0f;
        float offsetZ = Math.round(Float.parseFloat(val[2]) * 100) / 100.0f;
        if (offsetY != 0.0f || offsetZ != 0.0f) {
            StringBuilder msg = new StringBuilder();
            msg.append("[" + $m.getName() + "] Partition is not in its original position, only left/right movement is allowed.");
            if (offsetY != 0.0f) {
                msg.append(" Front-back (Y) offset: " + offsetY + " mm - move it back by " + Math.abs(offsetY) + " mm along the front-back axis.");
            }
            if (offsetZ != 0.0f) {
                msg.append(" Up-down (Z) offset: " + offsetZ + " mm - move it back by " + Math.abs(offsetZ) + " mm along the up-down axis.");
            }
            _result.getList().add(createParamModelResult(msg.toString(), $m));
        }
    }
end
```

## 8. Known gaps — verify before relying on these

- No confirmed way to read a true design-time "original position" snapshot;
  the `offset` parameter is the best available proxy.
- `isOrigin()` is explicitly documented as vendor-specific/non-general — don't
  reuse it for unrelated checks.
- Sign-to-direction (which of +X/-X is "left" vs "right") is orientation-dependent,
  not fixed.
- If a rule needs a method/field not listed here, don't guess the name — a wrong
  guess typically fails silently (condition never matches, rule never fires) rather
  than erroring, which is harder to debug than an upload error. Test the rule
  against a known-good and a known-bad model instance after upload to confirm it
  actually fires.

## 9. Field-tested finding (2026-09-06): avoid loops in `then`; use declarative `not`/`from` for nearest-neighbor logic

**Symptom:** A `then` block containing an imperative loop (`for (Type x : list) {...}`
enhanced-for, or a plain `while (...) {...}`) over `getSubModels()`/a `List`,
looking for something like "the nearest sibling model to the left/right along the
X axis", consistently produced a generic **"There is a syntax error in the rule"**
banner in the Homworks Studio upload UI, with no line number given. This happened
across multiple loop styles (enhanced-for with generics, indexed `while`), and
also independently of whether helper `function` blocks were used — ruling out
generics and `function` blocks as the sole cause.

**Root cause (inferred, not MCP-confirmed):** No confirmed example anywhere in
this reference uses *any* loop construct in a `then` block — every worked example
uses only straight-line `if`/assignment/`String.split()`. The only
iteration-like construct confirmed to work is `from` inside a `when` pattern
(`$p: FParameter(name == "offset") from $m.getAllParameter()`). This strongly
suggests the engine's `then`-block parser/sandbox does not support arbitrary
loops (a common restriction in constrained rule DSLs, to bound rule execution
time), even though it otherwise accepts general Java-like statements.

**Fix that worked:** Replace the imperative loop with declarative Drools pattern
matching in `when`, using `from` plus a negated (`not`) pattern to express
"nearest match on this side" — the classic Drools idiom for nearest-neighbor /
extremal-value queries, avoiding any loop in `then` entirely. Because a `when`
pattern that matches zero facts means the whole rule simply doesn't fire, split
the "has a neighbor on this side" and "no neighbor / open to edge" cases into
**separate rules** rather than trying to model an optional binding in one rule.

Example — finding the nearest sibling to the left of a partition along X, with a
fallback rule for when there's no such sibling:

```java
rule "Partition min width left - has neighbor"
when
    $m: FParamModel(brandGood != null && brandGood.brandGoodName != null &&
        brandGood.brandGoodName.toLowerCase().contains("partition"))
    $left: FParamModel(this != $m,
        getAbsoluteBoundingBox().getMax().x <= $m.getAbsoluteBoundingBox().getMin().x) from $m.getParent().getSubModels()
    not FParamModel(this != $m, this != $left,
        getAbsoluteBoundingBox().getMax().x <= $m.getAbsoluteBoundingBox().getMin().x,
        getAbsoluteBoundingBox().getMax().x > $left.getAbsoluteBoundingBox().getMax().x) from $m.getParent().getSubModels()
then
    float gap = $m.getAbsoluteBoundingBox().getMin().x - $left.getAbsoluteBoundingBox().getMax().x;
    // ... use $left, gap here; no loop needed ...
end

rule "Partition min width left - open to edge"
when
    $m: FParamModel(brandGood != null && brandGood.brandGoodName != null &&
        brandGood.brandGoodName.toLowerCase().contains("partition"))
    not FParamModel(this != $m,
        getAbsoluteBoundingBox().getMax().x <= $m.getAbsoluteBoundingBox().getMin().x) from $m.getParent().getSubModels()
then
    // no sibling to the left at all; measure against the enclosure instead
end
```

This version parsed cleanly into the Homworks Studio structured `when`/`then`
editor (no immediate syntax-error banner on import), where the loop-based
versions of the same logic did not.

> **Still not MCP-confirmed:** the `not` keyword and multi-condition `from`
> patterns shown above are standard Drools syntax, but weren't in the original
> 2026-09-03 MCP-confirmed set either — no worked example used them before this.
> Treat this section as a practical field observation, not a fully verified fact,
> until re-confirmed via the `custom-rule-assistant` MCP tool. If a rule using
> this pattern *does* throw a syntax error, bisect it: try a minimal rule with
> only a single `not FParamModel(...) from ...` pattern in isolation to confirm
> whether `not` itself is supported before assuming the rest of the pattern is
> at fault.
