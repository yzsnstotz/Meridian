import { GUI_PORT } from "../config";

const REQUEST_TIMEOUT_MS = 5_000;

export const SERVICE_UNREACHABLE_EXIT_CODE = 3;

export interface JsonRequestSuccess<T> {
  ok: true;
  body: T;
  base_url: string;
  status_code: number;
}

export interface JsonRequestFailure {
  ok: false;
  error: string;
  base_url: string;
  service_unreachable: boolean;
  status_code?: number;
}

export type JsonRequestResult<T> = JsonRequestSuccess<T> | JsonRequestFailure;

export async function requestRolesServiceJson<T>(pathname: string): Promise<JsonRequestResult<T>> {
  const baseUrl = resolveRolesServiceBaseUrl();
  const requestUrl = new URL(pathname, baseUrl);

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      ok: false,
      error: `Meridian-roles service unreachable at ${baseUrl}: ${asError(error).message}`,
      base_url: baseUrl,
      service_unreachable: true
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: await buildHttpErrorMessage(response, requestUrl.toString()),
      base_url: baseUrl,
      service_unreachable: false,
      status_code: response.status
    };
  }

  try {
    return {
      ok: true,
      body: await response.json() as T,
      base_url: baseUrl,
      status_code: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error: `Meridian-roles service returned invalid JSON from ${requestUrl.toString()}: ${asError(error).message}`,
      base_url: baseUrl,
      service_unreachable: false,
      status_code: response.status
    };
  }
}

export function buildServiceErrorData(result: JsonRequestFailure): Record<string, unknown> {
  return {
    base_url: result.base_url,
    service_unreachable: result.service_unreachable,
    exit_code: result.service_unreachable ? SERVICE_UNREACHABLE_EXIT_CODE : 1,
    ...(typeof result.status_code === "number" ? { status_code: result.status_code } : {})
  };
}

function resolveRolesServiceBaseUrl(): string {
  const explicitUrl = process.env.MERIDIAN_ROLES_HTTP?.trim();
  if (explicitUrl) {
    return new URL(explicitUrl).toString();
  }

  return `http://127.0.0.1:${GUI_PORT}`;
}

async function buildHttpErrorMessage(response: Response, requestUrl: string): Promise<string> {
  let bodyText = "";

  try {
    bodyText = (await response.text()).trim();
  } catch {
    bodyText = "";
  }

  const parsedMessage = parseErrorMessage(bodyText);
  if (parsedMessage) {
    return `Meridian-roles service request failed (${response.status}) at ${requestUrl}: ${parsedMessage}`;
  }

  if (response.statusText) {
    return `Meridian-roles service request failed (${response.status}) at ${requestUrl}: ${response.statusText}`;
  }

  return `Meridian-roles service request failed (${response.status}) at ${requestUrl}`;
}

function parseErrorMessage(bodyText: string): string | null {
  if (!bodyText) {
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
  } catch {
    return bodyText;
  }

  return bodyText;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
