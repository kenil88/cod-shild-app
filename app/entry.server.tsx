import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);

  const existingCsp = responseHeaders.get("Content-Security-Policy") || "";
  const crispDirectives: Record<string, string> = {
    "script-src": "https://client.crisp.chat",
    "style-src": "https://client.crisp.chat",
    "img-src": "https://*.crisp.chat https://*.crisp.help data:",
    "connect-src": "wss://*.crisp.chat https://*.crisp.chat",
    "frame-src": "https://*.crisp.chat",
    "font-src": "https://client.crisp.chat",
  };
  const updatedCsp = existingCsp
    ? existingCsp
        .split(";")
        .map((directive) => {
          const trimmed = directive.trim();
          const key = trimmed.split(" ")[0];
          return crispDirectives[key]
            ? `${trimmed} ${crispDirectives[key]}`
            : trimmed;
        })
        .join("; ")
    : "";
  if (updatedCsp) responseHeaders.set("Content-Security-Policy", updatedCsp);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
