interface Env {
  RESEND_API_KEY: string;
  RESEND_NEWSLETTER_AUDIENCE_ID: string;
  RESEND_ENTERPRISE_AUDIENCE_ID: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let email: string;
  let source: string;

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = await request.json<{ email?: string; source?: string }>();
    email = body.email ?? '';
    source = body.source ?? 'newsletter';
  } else {
    const form = await request.formData();
    email = (form.get('email') as string) ?? '';
    source = (form.get('source') as string) ?? 'newsletter';
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email address.' }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const audienceId =
    source === 'enterprise'
      ? env.RESEND_ENTERPRISE_AUDIENCE_ID
      : env.RESEND_NEWSLETTER_AUDIENCE_ID;

  const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const err = await res.json<{ message?: string }>();
    return new Response(
      JSON.stringify({ error: err.message ?? 'Failed to subscribe.' }),
      { status: 502, headers: corsHeaders }
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: corsHeaders,
  });
};

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
