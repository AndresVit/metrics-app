export type AttributeDatatype = 'int' | 'float' | 'string' | 'bool' | 'timestamp' | 'hierarchyString';

export class AttributeDefinition {
  definitionId: string;
  datatype: AttributeDatatype;

  constructor(definitionId: string, datatype: AttributeDatatype) {
    this.definitionId = definitionId;
    this.datatype = datatype;
  }
}
