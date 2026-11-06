// Cluster client: read what is actually running.
//
// This is the segment that fills in `pod_started_at` and answers "which image
// is running right now" from the cluster rather than from a human's word. It
// talks to the Rancher API's Kubernetes proxy, so no kubeconfig and no
// kubectl are needed -- the Rancher token is the only credential.
//
// The TLS certificate of a private Rancher is usually self-signed. Rather
// than turning verification off, the caller supplies the CA (a pinned
// certificate), so the connection stays verified against *that* CA.

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

export class CollectorError extends Error {}

export function createClusterClient({
  url,
  token,
  ca = null,
  cluster,
  namespace,
}) {
  const base = new URL(String(url).replace(/\/$/, ''));
  let caBundle = null;
  if (ca) {
    try {
      caBundle = readFileSync(ca);
    } catch (err) {
      throw new CollectorError(`cannot read CA file ${ca}: ${err.message}`);
    }
  }

  function fetchJson(path) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, base);
      const isHttps = target.protocol === 'https:';
      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
          },
          ...(isHttps ? { ca: caBundle ?? undefined } : {}),
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401 || res.statusCode === 403) {
              reject(
                new CollectorError(
                  `cluster refused the request (${res.statusCode}): ${text.slice(0, 160)}`,
                ),
              );
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new CollectorError(
                  `cluster returned ${res.statusCode} for ${path}`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(
                new CollectorError(
                  `cluster returned invalid JSON for ${path}: ${err.message}`,
                ),
              );
            }
          });
        },
      );
      req.on('error', (err) => {
        reject(
          new CollectorError(
            `cluster unreachable at ${base.host}: ${err.message}`,
          ),
        );
      });
      req.end();
    });
  }

  return {
    // Pods carry the running image and the moment the container started. The
    // digest is in `imageID`, which is what makes the running image
    // comparable with a registry digest.
    async listPods() {
      const path =
        `/k8s/clusters/${encodeURIComponent(cluster)}` +
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=500`;
      const body = await fetchJson(path);
      const items = Array.isArray(body?.items) ? body.items : [];
      const pods = [];
      for (const item of items) {
        const meta = item.metadata ?? {};
        const spec = item.spec ?? {};
        const status = item.status ?? {};
        const pod = {
          pod_name: meta.name ?? null,
          node: spec.nodeName ?? null,
          pod_scheduled_at: status.startTime ?? null,
          containers: [],
        };
        for (const cs of status.containerStatuses ?? []) {
          const running = cs.state?.running ?? null;
          pod.containers.push({
            image: cs.image ?? null,
            image_ref: cs.image ?? null,
            digest: digestFromImageId(cs.imageID),
            started_at: running?.startedAt ?? null,
            restarts: cs.restartCount ?? null,
            ready: cs.ready ?? null,
          });
        }
        pods.push(pod);
      }
      return pods;
    },
  };
}

// "docker-pullable://host/repo@sha256:..." -> "sha256:..."
export function digestFromImageId(imageId) {
  if (!imageId) return null;
  const at = imageId.indexOf('@');
  if (at === -1) return null;
  return imageId.slice(at + 1);
}

// "host:port/repo:tag" -> { repo, tag }
export function splitImageRef(imageRef) {
  if (!imageRef) return { repo: null, tag: null };
  const withoutScheme = imageRef.includes('://')
    ? imageRef.slice(imageRef.indexOf('://') + 3)
    : imageRef;
  const lastColon = withoutScheme.lastIndexOf(':');
  const lastSlash = withoutScheme.lastIndexOf('/');
  if (lastColon > lastSlash && lastColon !== -1) {
    return {
      repo: withoutScheme.slice(0, lastColon),
      tag: withoutScheme.slice(lastColon + 1),
    };
  }
  return { repo: withoutScheme, tag: null };
}
