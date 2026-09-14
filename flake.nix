{
  description = "Tauri v2 app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    crane.url = "github:ipetkov/crane";
    # crane-tauri declares no inputs of its own, so there is nothing to follow
    # or override (the previous follows clause warned about non-existent inputs).
    crane-tauri.url = "github:JPHutchins/crane-tauri";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    crane,
    crane-tauri,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib stdenv fetchYarnDeps nodejs;
        yarn-berry = pkgs.yarn-berry_4;

        craneLib = crane.mkLib pkgs;
        packageJSON = lib.importJSON ./package.json;

        frontend = stdenv.mkDerivation (finalAttrs: rec {
          pname = "${packageJSON.name}-app-${version}";
          inherit (packageJSON) version;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./yarn.lock
              ./tsconfig.json
              ./vite.config.ts
              ./svelte.config.js
              # ./index.html
              ./src
              # ./public
            ];
          };

          missingHashes = ./missing-hashes.json;
          offlineCache = yarn-berry.fetchYarnBerryDeps {
            inherit (finalAttrs) src missingHashes;
            hash = "sha256-8/MxKxc48qVQebQ80h8uBWJPBym1CSrpvIGkUc08Xc0=";
          };

          nativeBuildInputs = with pkgs; [
            nodejs
            yarn-berry
            yarn-berry.yarnBerryConfigHook
            npmHooks.npmInstallHook
          ];

          buildPhase = ''
            runHook preBuild
            yarn build
            runHook postBuild
          '';
          distPhase = "true";

          installPhase = ''
            runHook preInstall
            cp -r build $out
            runHook postInstall
          '';
        });

        tauri = crane-tauri.lib.buildTauriApp {inherit pkgs craneLib;} {
          pname = "app"; # TODO: change
          version = "0.1.0"; # TODO: change
          src = ./.;

          extraNativeBuildInputs = with pkgs; [
            # Video/Audio data composition framework tools like "gst-inspect", "gst-launch" ...
            gst_all_1.gstreamer
            # Common plugins like "filesrc" to combine within e.g. gst-launch
            gst_all_1.gst-plugins-base
            # Specialized plugins separated by quality
            gst_all_1.gst-plugins-good
            gst_all_1.gst-plugins-bad
            gst_all_1.gst-plugins-ugly
            # Plugins to reuse ffmpeg to play almost every video format
            gst_all_1.gst-libav
          ];

          inherit frontend;
        };
      in {
        packages = {
          inherit frontend;
          default = tauri.app;
          wrapped = tauri.wrappedApp;
        };

        checks = {
          inherit (tauri) app;
          wrapped = tauri.wrappedApp;

          clippy = craneLib.cargoClippy (
            tauri.commonArgs
            // {
              inherit (tauri) cargoArtifacts;
              cargoClippyExtraArgs = "--all-targets -- -D warnings";
              TAURI_CONFIG = tauri.tauriConfig;
            }
          );

          fmt = craneLib.cargoFmt {inherit (tauri.commonArgs) src;};
        };

        devShells.default = craneLib.devShell {
          checks = self.checks.${system};
          packages = with pkgs; [
            yarn-berry_4.yarn-berry-fetcher
            corepack

            # Video/Audio data composition framework tools like "gst-inspect", "gst-launch" ...
            gst_all_1.gstreamer
            # Common plugins like "filesrc" to combine within e.g. gst-launch
            gst_all_1.gst-plugins-base
            # Specialized plugins separated by quality
            gst_all_1.gst-plugins-good
            gst_all_1.gst-plugins-bad
            gst_all_1.gst-plugins-ugly
            # Plugins to reuse ffmpeg to play almost every video format
            gst_all_1.gst-libav
          ];
        };
      }
    );
}
