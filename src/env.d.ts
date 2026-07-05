type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
	interface Locals extends Runtime {
		actor?: string;
		user?: import("./lib/user-session").SessionUser | null;
	}
}
