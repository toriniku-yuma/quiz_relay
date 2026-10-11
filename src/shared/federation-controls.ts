export type FederationControl = {
  version: 1;
  eventId: string;
  type: 'withdrawal' | 'instance-deleted';
  subjectId: string;
  createdAt: number;
};
