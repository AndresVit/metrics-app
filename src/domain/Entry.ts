export class Entry {
  id: number;
  userId: string;
  definitionId: string;
  parentEntryId: number | null;
  timestamp: Date;
  subdivision: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: number,
    userId: string,
    definitionId: string,
    parentEntryId: number | null,
    timestamp: Date,
    subdivision: string | null,
    comments: string | null,
    createdAt: Date,
    updatedAt: Date
  ) {
    this.id = id;
    this.userId = userId;
    this.definitionId = definitionId;
    this.parentEntryId = parentEntryId;
    this.timestamp = timestamp;
    this.subdivision = subdivision;
    this.comments = comments;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}
