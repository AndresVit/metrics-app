export class MetricDefinition {
  definitionId: string;
  primaryIdentifierFieldId: string | null;

  constructor(definitionId: string, primaryIdentifierFieldId: string | null) {
    this.definitionId = definitionId;
    this.primaryIdentifierFieldId = primaryIdentifierFieldId;
  }
}
