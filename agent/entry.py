"""PyInstaller entry point — imports the package normally so relative imports
inside meterhouse/ resolve, unlike running __main__.py directly as a script.
"""

from meterhouse.cli import main

if __name__ == "__main__":
    main()
