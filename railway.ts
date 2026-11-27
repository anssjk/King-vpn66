import type { PanelConfig } from '@/lib/config';

/**
 * Creates the user's own panel on their Railway account with one token.
 *
 * Steps: check the token → create a project → create the service from the public panel repo
 * → put it in Amsterdam (the Netherlands) → give it a public domain → wait until it answers
 * → ask it for an access token. The Railway token is used only inside this function and is
 * never stored.
 */
const API = 'https://backboard.railway.com/graphql/v2';
const REGION_NETHERLANDS = 'europe-west4-drams3a';
const XRAY_PORT = 8443;

export type DeployStep = 'check' | 'project' | 'service' | 'region' | 'domain' | 'wait' | 'token';

export class RailwayError extends Error {}

type GqlResponse<T> = { data?: T; errors?: { message: string }[] };

const ENDPOINTS = ['https://backboard.railway.com/graphql/v2', 'https://backboard.railway.app/graphql/v2'];

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let last: RailwayError = new RailwayError('Could not reach Railway.');
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'king-vpn/1.0',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      const raw = await res.text();
      let body: GqlResponse<T> = {};
      try {
        body = JSON.parse(raw) as GqlResponse<T>;
      } catch {
        body = {};
      }
      if (body.errors?.length) {
        const m = body.errors[0].message;
        throw new RailwayError(
          /free plan|resource provision|upgrade/i.test(m)
            ? `${m} Delete old projects in Railway, or upgrade the plan (Hobby), then try again.`
            : m,
        );
      }
      if (res.ok && body.data) return body.data;
      // Not a GraphQL answer (a 403 page, for instance): keep the status and a bit of the
      // text so the real cause is visible, then try the other address.
      last = new RailwayError(`Railway answered ${res.status}: ${raw.replace(/\s+/g, ' ').slice(0, 140)}`);
    } catch (e) {
      if (e instanceof RailwayError) throw e;
      last = new RailwayError('Could not reach Railway. Check the internet and try again.');
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

function randomKey(): string {
  const bytes = new Uint8Array(24);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deployPanel(
  railwayToken: string,
  repo: string,
  onStep: (step: DeployStep) => void,
): Promise<PanelConfig> {
  const token = railwayToken.trim();

  onStep('check');
  // A personal token answers `me`; a workspace token only answers `apiToken`. Try both so
  // either kind works, and say clearly what to do when neither does.
  let workspaceId: string | undefined;
  let accepted = false;
  try {
    const w = await gql<{ me: { workspaces: { id: string }[] } }>(
      token,
      'query { me { workspaces { id } } }',
      {},
    );
    workspaceId = w.me.workspaces?.[0]?.id;
    accepted = true;
  } catch {
    /* try the workspace-token form below */
  }
  if (!accepted) {
    try {
      const w = await gql<{ apiToken: { workspaces: { id: string }[] } }>(
        token,
        'query { apiToken { workspaces { id } } }',
        {},
      );
      workspaceId = w.apiToken.workspaces?.[0]?.id;
      accepted = true;
    } catch {
      /* fall through to the readable error */
    }
  }
  if (!accepted) {
    throw new RailwayError(
      'Railway did not accept this token. Create a new one at railway.com/account/tokens, leave Workspace on "No workspace", and paste all of it.',
    );
  }

  onStep('project');
  const project = await gql<{
    projectCreate: { id: string; environments: { edges: { node: { id: string } }[] } };
  }>(
    token,
    `mutation($input: ProjectCreateInput!) {
       projectCreate(input: $input) { id environments { edges { node { id } } } }
     }`,
    { input: { name: `king-vpn-${Date.now().toString(36)}`, ...(workspaceId ? { workspaceId } : {}) } },
  );
  const projectId = project.projectCreate.id;
  const environmentId = project.projectCreate.environments.edges[0]?.node.id;
  if (!environmentId) throw new RailwayError('Railway made the project but no environment.');

  // Anything that fails after the project exists removes that project again, so a failed
  // try never leaves clutter that eats the free plan's small project limit.
  let keep = false;
  try {
    onStep('service');
    const service = await gql<{ serviceCreate: { id: string } }>(
      token,
      `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      {
        input: {
          projectId,
          environmentId,
          name: 'panel',
          source: { repo },
          branch: 'panel',
          variables: { ADMIN_KEY: randomKey(), PORT: '3000' },
        },
      },
    );
    const serviceId = service.serviceCreate.id;

    onStep('region');
    try {
      await gql(
        token,
        `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
           serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
         }`,
        { serviceId, environmentId, input: { region: REGION_NETHERLANDS } },
      );
    } catch {
      // The region is a preference: the panel still works from Railway's default one.
    }

    onStep('domain');
    const domain = await gql<{ serviceDomainCreate: { domain: string } }>(
      token,
      `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { serviceId, environmentId, targetPort: 3000 } },
    );
    const baseUrl = `https://${domain.serviceDomainCreate.domain}`;

    // REALITY runs on raw TCP, so it needs Railway's TCP Proxy (the HTTP domain cannot carry it).
    // Hand the proxy's public address to the panel so it can publish the right link.
    const proxy = await gql<{ tcpProxyCreate: { domain: string; proxyPort: number } }>(
      token,
      `mutation($input: TCPProxyCreateInput!) { tcpProxyCreate(input: $input) { domain proxyPort } }`,
      { input: { serviceId, environmentId, applicationPort: XRAY_PORT } },
    );
    await gql(
      token,
      `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables: {
            TCP_HOST: proxy.tcpProxyCreate.domain,
            TCP_PORT: String(proxy.tcpProxyCreate.proxyPort),
          },
        },
      },
    );

    onStep('wait');
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      await sleep(6000);
      try {
        const res = await fetch(`${baseUrl}/health`);
        up = res.ok;
      } catch {
        up = false;
      }
    }
    if (!up) {
      keep = true;
      throw new RailwayError('The panel is still building. Open Railway to see it, then try again in a few minutes.');
    }

    onStep('token');
    const res = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'app' }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    if (!res.ok || !body.token) throw new RailwayError('The panel is up but did not give a token.');
    return { baseUrl, token: body.token };
  } catch (e) {
    if (!keep) {
      try {
        await gql(token, 'mutation($id: String!) { projectDelete(id: $id) }', { id: projectId });
      } catch {
        /* nothing more to do */
      }
    }
    throw e;
  }
}
