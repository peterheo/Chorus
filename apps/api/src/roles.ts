/**
 * The ONE place that decides which room roles a verified SharedNet participant receives.
 *
 * INTERIM (room seq 51 partial hold): every verified member is granted `executor` only. Reviewer and
 * manager will come from a room policy once the role-model revision lands; the database function
 * `chorus_enroll_complete` currently refuses any other role set, so this cannot silently widen.
 */
export interface EnrollmentSubject {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly roomId: string;
}

export function rolesForEnrollment(_subject: EnrollmentSubject): string[] {
  return ['executor'];
}
