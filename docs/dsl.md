# Timing DSL Specification

## 1. Purpose

### 1.1 What TIM Represents

TIM (Timing) is a MetricDefinition that captures a single time interval with categorized time allocation. Each TIM entry represents one contiguous block of time with:
- Start and end times
- Duration
- Breakdown of how time was spent across categories (productive, meetings, planning, neutral)

### 1.2 Why Timing Blocks Exist

Timing blocks provide a compact DSL for logging multiple time intervals in a single input. Instead of creating entries one at a time, users can log an entire work session:

```
EST:TFG/coding;adv:10,project:thesis
1230-1310 t30m10
1310-1350 t35m5
1400-1430 t25m5
```

This creates three TIM entries and three parent (EST) entries, each with its own timing data.

### 1.3 Relation Between Parent Metric and TIM

Parent metrics (EST, READ, etc.) reference TIM via a required field:

```
METRIC EST
  timing: TIM
  adv: int
  project: string
END
```

Each timing line produces:
1. One TIM MetricEntry (timing data)
2. One parent MetricEntry (EST) with its `timing` field referencing that TIM

The TIM entry stores `parent_entry_id` pointing to the parent, enabling reverse navigation.

## 2. Block Structure

A timing block consists of a header line followed by one or more timing lines.

### 2.1 Header Line Format

```
DEF_CODE:subdivision;attr:value,attr:value[;tag:value,tag:value]
```

Components:
| Component | Required | Description |
|-----------|----------|-------------|
| `DEF_CODE` | Yes | Parent metric definition code (e.g., EST, READ) |
| `:subdivision` | No | Hierarchical context (e.g., TFG/coding) |
| `;attr:value,...` | Yes | Attribute values for the parent metric |
| `;tag:value,...` | No | Tags applied to all entries in the block |

Example:
```
EST:TFG/coding;adv:10,project:thesis;place:library,mood:focused
```

### 2.2 Timing Line Format

```
HHMM-HHMM <tokens> [| attr_overrides] [| tags]
```

Components:
| Component | Required | Description |
|-----------|----------|-------------|
| `HHMM-HHMM` | Yes | Time range in 24-hour format |
| `<tokens>` | Yes | Timing tokens (e.g., t30m10n5) |
| `\| attr_overrides` | No | Override header attributes for this line |
| `\| tags` | No | Additional tags for this line |

Example:
```
1230-1310 t30m10 | adv:8 | place:cafe
```

## 3. Time Rules

### 3.1 Time Format

Format: `HHMM-HHMM`

- HH: hours (00-23, or higher for next-day times)
- MM: minutes (00-59)
- No separator between hours and minutes
- Hyphen separates start and end times

### 3.2 Time Calculations

```
time_init = start_hour × 60 + start_minutes
time_end = end_hour × 60 + end_minutes
duration = time_end - time_init
```

### 3.3 Validation Rules

| Rule | Constraint |
|------|------------|
| Minutes range | 0-59 |
| Duration | Must be > 0 |
| Ordering | Lines must be chronologically ordered |
| Overlap | Time ranges must not overlap within a block |

### 3.4 Crossing Midnight

Times may exceed 24:00 to represent next-day times:

```
2315-2430    # 23:15 to 00:30 next day
```

Calculations:
- time_init = 23 × 60 + 15 = 1395
- time_end = 24 × 60 + 30 = 1470
- duration = 75 minutes

## 4. Timing Tokens

### 4.1 Token Syntax

Tokens encode time allocation across categories.

Basic format: `<letter><number>[<letter><number>...]`

```
t30m10n5     # t:30, m:10, n:5
t45          # t:45
t20m10p5n5   # t:20, m:10, p:5, n:5
```

With subcategories: `<letter>/<subcategory><number>`

```
t12m/thk5m3  # t:12, m/thk:5, m:3 (m/thk and m are separate values)
```

### 4.2 Token Base Categories

| Base | Meaning | Included in Productivity KPIs |
|------|---------|------------------------------|
| `t` | Task / productive work | Yes |
| `m` | Meeting / collaborative work | Yes |
| `p` | Planning / preparation | Yes |
| `n` | Neutral / breaks | No (excluded) |

These are the only valid base categories. Using other letters produces a FORMULA_ERROR when computing KPIs.

### 4.3 Subcategories

Subcategories provide finer granularity:

```
m/thk    # meeting/thinking
m/sw     # meeting/software discussion
t/deep   # task/deep work
t/admin  # task/administrative
```

Subcategories are aggregated under their base when using `time()`:
- `self.time("m")` sums all m, m/thk, m/sw values

### 4.4 Token Validation

| Rule | Constraint |
|------|------------|
| Sum limit | Sum of token values ≤ duration |
| Minimum | At least one token required |
| Base validity | Only t, m, p, n are valid for KPI formulas |

## 5. Data Model Mapping

### 5.1 TIM MetricEntry Structure

Each timing line produces one TIM MetricEntry with:

**Input Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `time_init` | int | Start time in minutes from midnight |
| `time_end` | int | End time in minutes from midnight |
| `duration` | int | Duration in minutes |
| `time_type` | int (1,n) | Multi-valued field for timing tokens |

**Computed KPI Fields:**
| Field | Formula |
|-------|---------|
| `gross_productivity` | `self.time("t") / self.duration` |
| `net_productivity` | `self.time("t") / (self.time("t") + self.time("m") + self.time("p"))` |
| `internal_productivity` | `self.time("t") / (self.time("t") + self.time("m"))` |
| `external_productivity` | `(self.time("t") + self.time("m")) / (self.time("t") + self.time("m") + self.time("p"))` |

### 5.2 time_type Field Values

Each token becomes a separate AttributeEntry on the `time_type` field:

| Token | Entry.subdivision | AttributeEntry.valueInt |
|-------|-------------------|------------------------|
| t30 | "t" | 30 |
| m10 | "m" | 10 |
| m/thk5 | "m/thk" | 5 |
| n5 | "n" | 5 |

### 5.3 Parent Entry Structure

The parent entry (EST, READ, etc.) contains:
- All attributes from the header line
- Override attributes from the timing line (if any)
- Tags from header and/or timing line
- `timing` field referencing the TIM entry (via inline metric entry)

## 6. Error Handling

### 6.1 Atomic Block Processing

If ANY error occurs during parsing or validation:
- The entire block is rejected
- No entries are created
- Error includes line number and reason

### 6.2 Error Types

| Error | Cause |
|-------|-------|
| Invalid time format | Malformed HHMM-HHMM |
| Invalid minutes | Minutes outside 0-59 |
| Zero/negative duration | End time ≤ start time |
| Time overlap | Ranges overlap within block |
| Time ordering | Lines not chronologically ordered |
| Token sum exceeded | Sum of tokens > duration |
| Missing tokens | No tokens on timing line |
| Unknown definition | DEF_CODE not found |
| Missing required field | Required attribute not provided |

### 6.3 Error Format

```
Line N: <reason>
```

Example:
```
Line 3: Token sum (55) exceeds duration (40)
```

## 7. Examples

### 7.1 Minimal Example

Input:
```
EST:TFG;adv:5,project:thesis
1400-1430 t25m5
```

Produces:
- 1 TIM entry: time_init=840, time_end=870, duration=30, time_type=[t:25, m:5]
- 1 EST entry: adv=5, project="thesis", timing→TIM

### 7.2 Multiple Lines with Overrides

Input:
```
EST:Work/sprint;adv:5,project:main
0900-0930 t20m10
0930-1000 t25m5 | adv:8
1000-1030 t30 | adv:10 | mood:focused
```

Produces:
- Line 1: EST(adv=5), TIM(t:20, m:10)
- Line 2: EST(adv=8), TIM(t:25, m:5)
- Line 3: EST(adv=10, tags=[mood:focused]), TIM(t:30)

### 7.3 With Subcategories

Input:
```
EST:TFG/research;adv:7,project:paper
1400-1500 t30m/thk15m5n10
```

Produces:
- TIM entry with time_type values:
  - subdivision="t", valueInt=30
  - subdivision="m/thk", valueInt=15
  - subdivision="m", valueInt=5
  - subdivision="n", valueInt=10
- KPI calculations:
  - gross_productivity = 30/60 = 0.5
  - net_productivity = 30/(30+20+0) = 0.6 (m/thk+m = 20)
  - internal_productivity = 30/(30+20) = 0.6
  - external_productivity = (30+20)/(30+20+0) = 1.0

### 7.4 Crossing Midnight

Input:
```
EST:Personal;adv:3,project:side
2300-2430 t60m30
```

Produces:
- TIM entry: time_init=1380, time_end=1470, duration=90
- time_type: [t:60, m:30]
