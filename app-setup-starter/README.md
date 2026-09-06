# Application handoff manifest

Copy `manifest.json` into the completed application's `app-setup/` directory and adjust it
for the task. The command arrays are run from the application workspace, so replace the
placeholder scripts and URLs with commands that work for the chosen stack.

Keep only the artifact entries that the task uses (`openapi` for an API and `uiContract` for a
browser UI); remove the other entry when it does not apply. The application must provide:

- `build`: installs or compiles dependencies, then exits;
- `start`: runs in the foreground and stays active until terminated;
- `reset`: stops the application, recreates a deterministic empty datastore, and exits;
- `urls.ready`: an HTTP 200 readiness endpoint that is true only when required dependencies are
  reachable.

List only the datastores the application actually uses. Keep the manifest and its scripts with
the submitted application, alongside its source and public contracts.
