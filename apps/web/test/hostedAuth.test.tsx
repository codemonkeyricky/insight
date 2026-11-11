import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthChip, AuthChipView } from "../src/components/HostedAuth";
import { AuthErrorLine, YourRepos, homeIntroText } from "../src/pages/HostedHome";
import { authErrorOf, indexErrorText } from "../src/hostedRepo";

// The components render to static markup: effects do not run, so the chip shows nothing until the state is known.

describe("header sign-in chip", () => {
  it("offers a sign-in link that returns to the current hash", () => {
    const html = renderToStaticMarkup(<AuthChipView me={{ enabled: true, signedIn: false }} hash="#/gh/o/r" onSignOut={() => undefined} />);
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('href="/api/auth/login?return=%23%2Fgh%2Fo%2Fr"');
    expect(html).not.toContain("Sign out");
  });

  it("shows the avatar, the login and a sign-out when signed in", () => {
    const html = renderToStaticMarkup(
      <AuthChipView me={{ enabled: true, signedIn: true, login: "octocat", avatarUrl: "https://avatars.test/1" }} hash="#/" onSignOut={() => undefined} />,
    );
    expect(html).toContain("@octocat");
    expect(html).toContain("Sign out");
    expect(html).toContain('src="https://avatars.test/1"');
    expect(html).not.toContain("Sign in with GitHub");
  });

  it("renders nothing before the sign-in state is known", () => {
    expect(renderToStaticMarkup(<AuthChip />)).toBe("");
  });
});

describe("hosted home intro", () => {
  it("keeps the public-only copy when sign-in is off", () => {
    expect(homeIntroText(false)).toBe(
      "Insight reads a public repository and shows its flow, architecture and findings. Indexes are read-only and stay online for anyone to open.",
    );
  });

  it("describes private indexes when sign-in is on", () => {
    expect(homeIntroText(true)).toBe(
      "Insight reads a GitHub repository and shows its flow, architecture and findings. Public indexes stay online for anyone to open; private ones only for people who can read the repository on GitHub.",
    );
  });
});

describe("header sign-in chip at a phone width", () => {
  it("carries the full sign-in text as its name and a short visible label", () => {
    const html = renderToStaticMarkup(<AuthChipView me={{ enabled: true, signedIn: false }} hash="#/" onSignOut={() => undefined} />);
    expect(html).toContain('aria-label="Sign in with GitHub"');
    expect(html).toContain('title="Sign in with GitHub"');
    expect(html).toContain('<span class="auth-short">Sign in</span>');
  });

  it("keeps the login in the title of the signed-in chip", () => {
    const html = renderToStaticMarkup(
      <AuthChipView me={{ enabled: true, signedIn: true, login: "octo", avatarUrl: "https://avatars.test/2" }} hash="#/" onSignOut={() => undefined} />,
    );
    expect(html).toContain('title="@octo"');
    expect(html).toContain("Sign out");
  });
});

describe("your repositories", () => {
  const install = "https://github.com/apps/insight-viewer/installations/new";

  it("lists each repository as a link to its index, with a lock on the private ones", () => {
    const html = renderToStaticMarkup(
      <YourRepos
        repos={[
          { repo: "o/secret", private: true },
          { repo: "o/open", private: false },
        ]}
        installUrl={install}
      />,
    );
    expect(html).toContain("Your repositories");
    expect(html).toContain('href="#/gh/o/secret"');
    expect(html).toContain('href="#/gh/o/open"');
    expect(html.match(/aria-label="Private"/g)).toHaveLength(1);
    expect(html).toContain("Add repositories");
    expect(html).toContain(`href="${install}"`);
  });

  it("asks for the app to be installed when the list is empty", () => {
    const html = renderToStaticMarkup(<YourRepos repos={[]} installUrl={install} />);
    expect(html).toContain("Install the Insight app on a repository to index it");
    expect(html).toContain(`href="${install}"`);
    expect(html).not.toContain("Add repositories");
  });

  it("shows loading and error states", () => {
    expect(renderToStaticMarkup(<YourRepos repos={null} />)).toContain("Loading");
    const failed = renderToStaticMarkup(<YourRepos repos={null} error="Could not load your repositories." />);
    expect(failed).toContain("Could not load your repositories.");
    expect(failed).not.toContain("Loading");
  });
});

describe("sign-in errors", () => {
  it("reads auth_error from the hash query", () => {
    expect(authErrorOf("#/?auth_error=access_denied")).toBe("access_denied");
    expect(authErrorOf("#/")).toBeUndefined();
    expect(authErrorOf("#/?other=1")).toBeUndefined();
    expect(authErrorOf("#/?auth_error=%3Cb%3E")).toBeUndefined();
  });

  it("shows the code in a dismissible line", () => {
    const html = renderToStaticMarkup(<AuthErrorLine code="access_denied" onDismiss={() => undefined} />);
    expect(html).toContain("Sign-in failed (access_denied).");
    expect(html).toContain("Dismiss");
  });

  it("says a private repository needs sign-in when the index is refused", () => {
    expect(indexErrorText("auth_required", "o/r")).toBe("o/r is private. Sign in with GitHub to index it.");
  });
});
