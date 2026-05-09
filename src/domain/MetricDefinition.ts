export type SearchKeyType = 'attribute' | 'subdivision';

export class MetricDefinition {
  definitionId: string;
  primaryIdentifierFieldId: string | null;
  /** Field ID of the search key (only when searchKeyType is 'attribute') */
  searchKeyFieldId: string | null;
  /** Whether the search key is an attribute field or the subdivision string */
  searchKeyType: SearchKeyType | null;

  constructor(
    definitionId: string,
    primaryIdentifierFieldId: string | null,
    searchKeyFieldId: string | null = null,
    searchKeyType: SearchKeyType | null = null
  ) {
    this.definitionId = definitionId;
    this.primaryIdentifierFieldId = primaryIdentifierFieldId;
    this.searchKeyFieldId = searchKeyFieldId;
    this.searchKeyType = searchKeyType;
  }
}
