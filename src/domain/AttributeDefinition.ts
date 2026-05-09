// Attribute datatypes matching database CHECK constraint:
// - 'int': integer values (stored in value_int column)
// - 'float': decimal values (stored in value_float column)
// - 'string', 'bool', 'timestamp', 'hierarchyString': other types
// Note: 'number' is NOT valid - use 'int' or 'float' explicitly
export type AttributeDatatype = 'int' | 'float' | 'string' | 'bool' | 'timestamp' | 'hierarchyString';

export class AttributeDefinition {
  definitionId: string;
  datatype: AttributeDatatype;

  constructor(definitionId: string, datatype: AttributeDatatype) {
    this.definitionId = definitionId;
    this.datatype = datatype;
  }
}
