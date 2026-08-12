{
  description = "Node-native Pi port of oh-my-pi's hashline read/edit workflow";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          buildNpmPackage = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_22; };
          package = buildNpmPackage {
            pname = packageJson.name;
            version = packageJson.version;
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./LICENSE
                ./README.md
                ./package-lock.json
                ./package.json
                ./src
              ];
            };
            npmDepsHash = "sha256-ppkPdYhg7O2NOYo100ynr7dQ3RnAig0W8sJx1IMLFrw=";
            dontNpmBuild = true;
            npmInstallFlags = [
              "--omit=dev"
              "--omit=peer"
              "--ignore-scripts"
            ];
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -r LICENSE README.md package.json src node_modules "$out"
              runHook postInstall
            '';
          };
        in
        {
          "${packageJson.name}" = package;
          default = package;
        }
      );
    };
}
