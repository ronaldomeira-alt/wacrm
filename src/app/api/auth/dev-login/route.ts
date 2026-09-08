import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";

const DEV_EMAIL = "ronaldomeiracorretor@gmail.com";

/**
 * GET /api/auth/dev-login?redirect=/inbox
 *
 * Development-only automatic login endpoint.
 * Generates an authenticated Supabase session for the primary CRM owner
 * and sets the standard Supabase auth cookies on the response before
 * redirecting to the requested page (default: /inbox).
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: "Dev login is only available in development mode" },
      { status: 403 }
    );
  }

  const redirectParam = request.nextUrl.searchParams.get("redirect") || "/inbox";
  const redirectPath = redirectParam.startsWith("/") ? redirectParam : "/inbox";

  // Respect reverse proxy headers (e.g. Cloudflare tunnel) so redirects
  // keep the tunnel hostname instead of falling back to localhost:3100.
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const redirectUrl = host
    ? `${proto}://${host}${redirectPath}`
    : new URL(redirectPath, request.url).toString();

  const response = NextResponse.redirect(redirectUrl);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  try {
    const admin = supabaseAdmin();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: DEV_EMAIL,
    });

    if (linkError || !linkData?.properties?.hashed_token) {
      console.error("[dev-login] generateLink error:", linkError);
      return NextResponse.json(
        { error: linkError?.message || "Failed to generate magic link" },
        { status: 500 }
      );
    }

    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });

    if (verifyError) {
      console.error("[dev-login] verifyOtp error:", verifyError);
      return NextResponse.json(
        { error: verifyError.message },
        { status: 500 }
      );
    }

    return response;
  } catch (err) {
    console.error("[dev-login] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/auth/dev-login
 *
 * Returns a valid session object with access_token and refresh_token
 * for client-side hydration in AuthProvider (use-auth.tsx).
 */
export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: "Dev login is only available in development mode" },
      { status: 403 }
    );
  }

  try {
    const admin = supabaseAdmin();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: DEV_EMAIL,
    });

    if (linkError || !linkData?.properties?.email_otp) {
      return NextResponse.json(
        { error: linkError?.message || "Failed to generate OTP" },
        { status: 500 }
      );
    }

    const anonClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { data, error } = await anonClient.auth.verifyOtp({
      email: DEV_EMAIL,
      token: linkData.properties.email_otp,
      type: "magiclink",
    });

    if (error || !data.session) {
      return NextResponse.json(
        { error: error?.message || "Failed to obtain session" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      session: data.session,
      user: data.user,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
