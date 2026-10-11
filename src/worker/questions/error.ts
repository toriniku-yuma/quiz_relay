import { OrganizationError } from '../organization/access.ts';

export class QuestionError extends OrganizationError {
  readonly issues: { path: string; message: string }[];
  constructor(
    code: string,
    status: 400 | 403 | 404 | 409 = 400,
    issues: { path: string; message: string }[] = [],
  ) {
    super(code, status);
    this.issues = issues;
  }
}
