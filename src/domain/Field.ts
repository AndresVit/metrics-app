export type InputMode = 'input' | 'formula';

export class Field {
  id: string;
  userId: string;
  metricDefinitionId: string;
  name: string;
  baseDefinitionId: string;
  minInstances: number;
  maxInstances: number | null;
  inputMode: InputMode;
  formula: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: string,
    userId: string,
    metricDefinitionId: string,
    name: string,
    baseDefinitionId: string,
    minInstances: number,
    maxInstances: number | null,
    inputMode: InputMode,
    formula: string | null,
    createdAt: Date,
    updatedAt: Date
  ) {
    this.id = id;
    this.userId = userId;
    this.metricDefinitionId = metricDefinitionId;
    this.name = name;
    this.baseDefinitionId = baseDefinitionId;
    this.minInstances = minInstances;
    this.maxInstances = maxInstances;
    this.inputMode = inputMode;
    this.formula = formula;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}
