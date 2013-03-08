//
// Flow Log Controller.
//

define([], function () {

	return Em.ArrayProxy.create({
		content: [],
		types: Em.Object.create(),
		get_flowlet: function (id) {
			id = id + "";
			var content = this.types.Flowlet.content;
			for (var k = 0; k < content.length; k++) {
				if (content[k].name === id) {
					return content[k];
				}
			}
			content = this.types.Stream.content;
			for (k = 0; k < content.length; k++) {
				if (content[k].name === id) {
					return content[k];
				}
			}
		},

		__currentFlowletLabel: 'processed.count',

		load: function (app, id) {

			var self = this;

			function resize () {
				$('#logView').css({height: ($(window).height() - 240) + 'px'});
			}

			C.interstitial.loading();
			C.get('metadata', {
				method: 'getQuery',
				params: ['Query', {
					application: app,
					id: id
				}]
			}, function (error, response) {

				response.params.currentState = 'UNKNOWN';
				response.params.version = -1;
				response.params.type = 'Query';
				response.params.applicationId = app;

				self.set('current', C.Mdl.Query.create(response.params));

				resize();

			});

			var goneOver = false;

			function logInterval () {

				if (C.router.currentState.get('path') !== 'root.queries.log') {
					clearInterval(self.interval);
					return;
				}

				resize();

				C.get('monitor', {
					method: 'getLog',
					params: [app, id, 1024 * 10]
				}, function (error, response) {

					if (C.router.currentState.get('path') !== 'root.queries.log') {
						clearInterval(self.interval);
						return;
					}

					if (C.router.currentState.name !== 'log') {
						return;
					}

					if (error) {

						response = JSON.stringify(error);

					} else {

						var items = response.params;
						for (var i = 0; i < items.length; i ++) {
							items[i] = '<code>' + items[i] + '</code>';
						}
						response = items.join('');

						if (items.length === 0) {
							response = '[ No Log Messages ]';
						}

					}

					$('#logView').html(response);
					var textarea = $('#logView');

					setTimeout(function () {

						// Content exceeds height
						if (textarea[0].scrollHeight > textarea.height()) {

							if (!goneOver) {
								textarea.scrollTop(textarea[0].scrollHeight);
								goneOver = true;
							}

							// Scrolled off the bottom
							if (textarea[0].scrollTop + textarea.height() > textarea[0].scrollHeight) {
								textarea.scrollTop(textarea[0].scrollHeight);
							}

						}

					}, 100);

					C.interstitial.hide();

				});

			}

			logInterval();

			this.interval = setInterval(logInterval, 1000);

		},

		interval: null,
		unload: function () {

			this.get('content').clear();
			this.set('content', []);
			this.set('current', null);
			clearInterval(this.interval);

		}

	});
});