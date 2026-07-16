# ozwell-studio-launcher client (Vite + React on @mieweb/ui)
#
#   make deps      install dependencies
#   make build     production build to dist/
#   make install   copy dist/ to $(DESTDIR)$(PREFIX)/client/dist
#   make dev       Vite dev server (HMR, /socket.io proxied to :3000)
#   make watch     rebuild dist/ on change (used by the server's `make dev`)

PREFIX  ?= /opt/ozwell-studio-launcher
DESTDIR ?=

.PHONY: deps build install dev watch

deps: node_modules

node_modules: package.json package-lock.json
	npm ci
	touch node_modules

build: node_modules
	npm run build

install: build
	mkdir -p $(DESTDIR)$(PREFIX)/client/dist
	cp -r dist/. $(DESTDIR)$(PREFIX)/client/dist/

dev: node_modules
	npm run dev

watch: node_modules
	npx vite build --watch
