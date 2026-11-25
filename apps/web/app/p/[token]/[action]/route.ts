import { handlePatientAction } from '../actions';

interface Context {
  params: Promise<{ token: string; action: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { token, action } = await context.params;
  return handlePatientAction(request, token, action);
}
