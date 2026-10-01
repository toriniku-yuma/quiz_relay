import { OrganizationError } from '../organization/access.ts';
export type RoomRejection = {
  ok: false;
  code: string;
  status: OrganizationError['status'];
};
export function roomResult<T>(result: T): Exclude<T, RoomRejection> {
  if (
    result &&
    typeof result === 'object' &&
    'ok' in result &&
    result.ok === false &&
    'status' in result &&
    'code' in result
  )
    throw new OrganizationError(
      (result as RoomRejection).code,
      (result as RoomRejection).status,
    );
  return result as Exclude<T, RoomRejection>;
}
export async function roomRpc<T>(
  operation: () => Promise<T>,
): Promise<T | RoomRejection> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OrganizationError)
      return { ok: false, code: error.code, status: error.status };
    throw error;
  }
}
