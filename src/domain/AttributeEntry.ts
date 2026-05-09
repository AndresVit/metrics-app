export class AttributeEntry {
  entryId: number;
  fieldId: string;
  valueInt: number | null;
  valueFloat: number | null;
  valueString: string | null;
  valueBool: boolean | null;
  valueTimestamp: Date | null;
  valueHierarchy: string | null;
  /** DB id of the referenced entry (for metric-reference fields) */
  valueEntryId: number | null;

  constructor(
    entryId: number,
    fieldId: string,
    valueInt: number | null,
    valueFloat: number | null,
    valueString: string | null,
    valueBool: boolean | null,
    valueTimestamp: Date | null,
    valueHierarchy: string | null,
    valueEntryId: number | null = null
  ) {
    this.entryId = entryId;
    this.fieldId = fieldId;
    this.valueInt = valueInt;
    this.valueFloat = valueFloat;
    this.valueString = valueString;
    this.valueBool = valueBool;
    this.valueTimestamp = valueTimestamp;
    this.valueHierarchy = valueHierarchy;
    this.valueEntryId = valueEntryId;
  }
}
