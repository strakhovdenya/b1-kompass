import { startCommand } from '../../../../server/attempts/start';
import { commandResponse, readCommandBody } from '../../../../server/next/http';
import { getServerDeps, readGuestToken } from '../../../../server/next/request';

export const dynamic = 'force-dynamic';

// The explicit start. Origin, method, type and size are checked before the
// session; the guest comes only from the httpOnly cookie.
export const POST = async (request: Request): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const result = await startCommand(
    getServerDeps(),
    await readGuestToken(),
    command.body,
  );
  return commandResponse(result);
};
