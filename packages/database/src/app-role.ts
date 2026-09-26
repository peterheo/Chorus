import pg from 'pg';

export const APP_ROLE = 'chorus_app';

/**
 * Sets the login password of the runtime role. The migration creates the role without one so no
 * secret lives in the repository; operators and test setup supply it out of band.
 */
export async function setAppRolePassword(client: pg.ClientBase, password: string): Promise<void> {
  if (password === '') throw new Error('The app role password must not be empty.');
  await client.query(`ALTER ROLE ${APP_ROLE} PASSWORD ${pg.escapeLiteral(password)}`);
}
