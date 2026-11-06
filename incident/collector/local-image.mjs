// Local docker image and container facts.
//
// The registry segment of the collector answers "what is this image" for images
// that were *pushed*. The lab fixture is never pushed anywhere: it is built
// locally and run as a container, and its OCI label is the only place that
// says which commit went into it.
//
// So this module reads the same three facts from the local docker daemon:
//
//   image id    -- the content hash of the built image
//   labels      -- including org.opencontainers.image.revision, the image's
//                  own statement of which commit it was built from
//   container   -- when the container that runs it started
//
// Nothing here is networked and nothing here holds a credential, but it is
// still part of the collector: the agent's read side never sees a docker
// socket.

import { execFileSync } from 'node:child_process';

export class LocalImageError extends Error {}

function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String(err.stderr ?? err.message ?? '')
      .trim()
      .slice(0, 200);
    throw new LocalImageError(
      `docker ${args[0]} failed${detail ? `: ${detail}` : ''}`,
    );
  }
}

function inspect(kind, name) {
  // `docker inspect container <name>` 不是合法用法（container 是 inspect 的
  // 结果类型，不是子命令）；镜像用 `docker image inspect`，容器用 `docker inspect`。
  const args =
    kind === 'image' ? ['image', 'inspect', name] : ['inspect', name];
  const out = docker(args);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new LocalImageError(
      `docker inspect ${kind} ${name} returned invalid JSON`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new LocalImageError(
      `docker inspect ${kind} ${name} returned nothing`,
    );
  }
  return parsed[0];
}

// The image itself. `imageId` is docker's content hash -- for a locally built
// image that is the same kind of identity a registry digest is: change any
// byte of the content and it changes.
export function readLocalImage(imageRef) {
  const info = inspect('image', imageRef);
  const labels = info.Config?.Labels ?? {};
  const revision = labels['org.opencontainers.image.revision'] ?? null;
  const buildTime = labels['io.incident-lab.build-time'] ?? null;
  return {
    image_ref: imageRef,
    image_id: info.Id ?? null,
    created_at: info.Created ?? null,
    labels,
    // The image's own statement of which commit it was built from. `null`
    // when the image carries no such label -- and the caller must then treat
    // the commit as unknown, not as "the current HEAD".
    revision: revision && revision !== 'unknown' ? revision : null,
    // When this image was actually built, as the build said at the time.
    //
    // `created_at` cannot answer that: BuildKit serves a cached image with
    // the *oldest layer's* timestamp in its config, so after a rebuild that
    // changed only a label, `created_at` still points at the first build.
    // The build therefore stamps its own clock into a label, and the label
    // is what the ledger records. `null` means the image was not built by
    // this lab -- and the caller must then fall back, not invent a time.
    built_at: buildTime && buildTime !== 'unknown' ? buildTime : null,
  };
}

// The container that runs it. `started_at` is when the container started,
// which is the deployment anchor for the lab fixture.
export function readContainer(containerName) {
  const info = inspect('container', containerName);
  return {
    container: containerName,
    image_ref: info.Config?.Image ?? null,
    image_id: info.Image ?? null,
    started_at: info.State?.StartedAt ?? null,
    running: Boolean(info.State?.Running),
  };
}

// The running image of a container, merged with the image's own labels.
//
// `image_id` from the container is the id of the image that is *running*,
// which is not necessarily the image with that tag right now -- a rebuild
// re-points the tag. The ledger wants the running one, so the container is
// the authority on the id and the image is the authority on the labels.
export function readRunningImage(containerName) {
  const container = readContainer(containerName);
  if (!container.image_id) {
    throw new LocalImageError(
      `container ${containerName} has no image id: nothing to attribute`,
    );
  }
  const image = readLocalImage(container.image_id);
  return {
    ...image,
    image_ref: container.image_ref ?? image.image_ref,
    image_id: container.image_id,
    container_started_at: container.started_at,
    running: container.running,
  };
}
