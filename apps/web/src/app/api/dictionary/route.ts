import { readCommandBody } from '../../../server/next/http';
import {
  lookupDictionaryWord,
  refuseOversizedLookup,
} from '../../../server/next/dictionary';
import { readGuestToken } from '../../../server/next/request';

export const dynamic = 'force-dynamic';

// The lookup of one German word for the dictionary card. Method, Origin,
// type, size and JSON are checked (readCommandBody), then the tighter limit of
// a lookup body, before the guest of the httpOnly cookie is verified with
// resolveGuestSession; the word goes only to server/dictionary. Every answer
// is private, no-store.
export const POST = async (request: Request): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const oversized = refuseOversizedLookup(request);
  if (oversized) return oversized;
  return lookupDictionaryWord(await readGuestToken(), command.body);
};
