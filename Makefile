# ozwell-studio-launcher server
#
#   make deps      install dependencies (server + client)
#   make build     build the client bundle the server serves
#   make test      run the server test suite (node:test)
#   make install   install to $(DESTDIR)$(PREFIX) (default /opt/ozwell-studio-launcher)
#   make dev       run the server with auto-reload + client rebuild on change

PREFIX  ?= /opt/ozwell-studio-launcher
LIBDIR  ?= /usr/lib
DESTDIR ?=

.PHONY: deps build test install dev

deps: node_modules
	$(MAKE) -C client deps

node_modules: package.json package-lock.json
	npm ci
	touch node_modules

build:
	$(MAKE) -C client build

test: node_modules
	npm test

install: build
	mkdir -p $(DESTDIR)$(PREFIX)
	cp -r src patches package.json package-lock.json $(DESTDIR)$(PREFIX)/
	cd $(DESTDIR)$(PREFIX) && npm ci --omit=dev
	$(MAKE) -C client install DESTDIR=$(DESTDIR) PREFIX=$(PREFIX)
	mkdir -p $(DESTDIR)$(LIBDIR)/systemd/system
	sed 's|@PREFIX@|$(PREFIX)|g' \
	  contrib/ozwell-studio-launcher.service.in \
	  > $(DESTDIR)$(LIBDIR)/systemd/system/ozwell-studio-launcher.service

# Server restarts on source changes (node --watch); the client is rebuilt
# on change by vite build --watch, so the served dist/ stays fresh.
dev: node_modules
	trap 'kill 0' EXIT INT TERM; \
	$(MAKE) -C client watch & \
	node --watch src/server.js
