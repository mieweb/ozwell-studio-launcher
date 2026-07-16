# ozwell-studio-launcher server
#
#   make deps      install dependencies (server + client)
#   make build     build the client bundle the server serves
#   make install   install to $(DESTDIR)$(PREFIX) (default /opt/ozwell-studio-launcher)
#   make dev       run the server with auto-reload + client rebuild on change

PREFIX  ?= /opt/ozwell-studio-launcher
DESTDIR ?=

.PHONY: deps build install dev

deps: node_modules
	$(MAKE) -C client deps

node_modules: package.json package-lock.json
	npm ci
	touch node_modules

build:
	$(MAKE) -C client build

install: build
	mkdir -p $(DESTDIR)$(PREFIX)
	cp -r src package.json package-lock.json $(DESTDIR)$(PREFIX)/
	cd $(DESTDIR)$(PREFIX) && npm ci --omit=dev
	$(MAKE) -C client install DESTDIR=$(DESTDIR) PREFIX=$(PREFIX)

# Server restarts on source changes (node --watch); the client is rebuilt
# on change by vite build --watch, so the served dist/ stays fresh.
dev: node_modules
	trap 'kill 0' EXIT INT TERM; \
	$(MAKE) -C client watch & \
	node --watch src/server.js
