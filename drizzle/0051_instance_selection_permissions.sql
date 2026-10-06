REVOKE ALL ON quiz_game.account_instance_selections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON quiz_game.account_instance_selections TO quiz_organization;
