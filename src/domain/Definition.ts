export type DefinitionType = 'metric' | 'attribute';

export class Definition {
  id: string;
  userId: string;
  type: DefinitionType;
  code: string;
  displayName: string;
  category: string | null;
  parentDefinitionId: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: string,
    userId: string,
    type: DefinitionType,
    code: string,
    displayName: string,
    category: string | null,
    parentDefinitionId: string | null,
    createdAt: Date,
    updatedAt: Date
  ) {
    this.id = id;
    this.userId = userId;
    this.type = type;
    this.code = code;
    this.displayName = displayName;
    this.category = category;
    this.parentDefinitionId = parentDefinitionId;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}
