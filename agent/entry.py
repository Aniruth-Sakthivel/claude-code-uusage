"""PyInstaller entry point — imports the package normally so relative imports
inside claudefleet/ resolve, unlike running __main__.py directly as a script.
"""

from claudefleet.cli import main

if __name__ == "__main__":
    main()
