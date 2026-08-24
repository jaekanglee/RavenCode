"""Plain vault creation contract — no Raven policy content is injected."""
import asyncio
from pathlib import Path

from typer.testing import CliRunner

from raven.core.vault import Vault


def test_default_create_leaves_a_plain_markdown_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    root = tmp_path / "notes"

    vault = Vault.create("notes", root)

    assert vault.root == root.resolve()
    assert (root / "content").is_dir()
    for forbidden in (
        "_meta",
        "log.md",
        "WELCOME.md",
        ".git",
        ".gitignore",
    ):
        assert not (root / forbidden).exists(), forbidden


def test_retired_bootstrap_guide_and_freshness_surfaces_are_not_registered():
    """Plain vaults never expose policy injection or template-tracking controls."""
    from mcp.server.mcpserver import MCPServer

    from raven.api.server import app
    from raven.cli.__main__ import app as cli_app
    from raven.mcp.cli import register_tools
    from raven.mcp.resources import register_resources

    routes = {route.path for route in app.routes}
    assert "/api/vaults/{name}/verify" not in routes
    assert "/api/vaults/verify-all" not in routes
    assert "/api/vaults/{name}/bootstrap" not in routes
    assert "/api/vaults/{name}/guide/{kind:path}" not in routes
    assert "/api/vaults/{name}/guide-diff/{kind:path}" not in routes

    runner = CliRunner()
    root_help = runner.invoke(cli_app, ["--help"])
    vault_help = runner.invoke(cli_app, ["vault", "--help"])
    assert root_help.exit_code == 0
    assert vault_help.exit_code == 0
    assert "meta" not in root_help.output.lower()
    assert "bootstrap" not in vault_help.output.lower()
    assert "verify" not in vault_help.output.lower()

    tools_mcp = MCPServer("plain-vault-tools")
    register_tools(tools_mcp, "read")
    tool_names = {tool.name for tool in asyncio.run(tools_mcp.list_tools())}
    assert tool_names.isdisjoint({"wiki_get_guide", "wiki_get_guide_diff", "wiki_check_freshness"})

    resources_mcp = MCPServer("plain-vault-resources")
    register_resources(resources_mcp)
    resource_uris = {resource.uri_template for resource in asyncio.run(resources_mcp.list_resource_templates())}
    assert "wiki://{vault}/schema" not in resource_uris
