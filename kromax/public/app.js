/* global angular, LightweightCharts */
"use strict";
angular
  .module("kronosLab", [])
  .controller("LabController", [
    "$http",
    "$timeout",
    "$interval",
    "$scope",
    function ($http, $timeout, $interval, $scope) {
      var vm = this;
      var pollTimer, elapsedTimer;
      vm.form = {
        ticker: "AAPL",
        horizon: 10,
        model: "small",
        seed: 42,
        saveOutput: false,
      };
      vm.today = new Date().toISOString().slice(0, 10);
      $http.get("/api/health").then(
        function () {
          vm.connected = true;
        },
        function () {
          vm.connected = false;
        },
      );

      function dateString(date) {
        if (!date) return undefined;
        return [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
        ].join("-");
      }
      function stop() {
        vm.busy = false;
        $timeout.cancel(pollTimer);
        $interval.cancel(elapsedTimer);
      }
      function fail(error) {
        vm.error = error;
        stop();
      }
      function poll(id, retries) {
        $http.get("/api/forecasts/" + id).then(
          function (response) {
            var job = response.data;
            vm.progress = job.message;
            if (job.status === "complete") {
              vm.result = job.result;
              vm.output = job.output;
              stop();
              return;
            }
            if (job.status === "failed") {
              fail(job.error);
              return;
            }
            pollTimer = $timeout(function () {
              poll(id, 0);
            }, 1000);
          },
          function (response) {
            if (response.status === 404 || retries >= 5) {
              fail(
                (response.data && response.data.error) ||
                  "Lost connection to the server. Please try again.",
              );
              return;
            }
            vm.progress = "Reconnecting to the forecast…";
            pollTimer = $timeout(function () {
              poll(id, retries + 1);
            }, 2000);
          },
        );
      }
      vm.submit = function () {
        if (vm.busy) return;
        vm.error = null;
        vm.output = null;
        var request = angular.copy(vm.form);
        request.start = dateString(request.start);
        request.end = dateString(request.end);
        request.horizon = Number(request.horizon);
        if (request.start && request.end && request.start > request.end) {
          vm.error = "Start date must be on or before end date.";
          return;
        }
        vm.result = null;
        vm.busy = true;
        vm.elapsed = 0;
        vm.progress = "Submitting your analysis…";
        var started = Date.now();
        elapsedTimer = $interval(function () {
          vm.elapsed = Math.floor((Date.now() - started) / 1000);
        }, 1000);
        $http.post("/api/forecasts", request).then(
          function (response) {
            poll(response.data.id, 0);
          },
          function (response) {
            fail(
              (response.data && response.data.error) ||
                "Could not reach the server. Please try again.",
            );
          },
        );
      };
      vm.download = function () {
        var rows = [["kind", "date", "open", "high", "low", "close", "volume"]];
        ["history", "forecast"].forEach(function (kind) {
          vm.result[kind].forEach(function (c) {
            rows.push([kind, c.time, c.open, c.high, c.low, c.close, c.volume]);
          });
        });
        var blob = new Blob(
          [
            rows
              .map(function (row) {
                return row.join(",");
              })
              .join("\n"),
          ],
          { type: "text/csv;charset=utf-8" },
        );
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = vm.result.ticker + "-kronos-forecast.csv";
        a.click();
        $timeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
      };
      $scope.$on("$destroy", stop);
    },
  ])
  .directive("candleChart", function () {
    return {
      restrict: "E",
      scope: { result: "=" },
      link: function (scope, element) {
        var host = element[0];
        var chart = LightweightCharts.createChart(host, {
          height: 390,
          width: host.clientWidth,
          layout: {
            background: { color: "#111820" },
            textColor: "#8f9cac",
            fontFamily: "monospace",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: "#19222d" },
            horzLines: { color: "#19222d" },
          },
          rightPriceScale: { borderColor: "#26313f" },
          timeScale: { borderColor: "#26313f", rightOffset: 5 },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        });
        var history = chart.addCandlestickSeries({
          upColor: "#61c9b0",
          downColor: "#d67d86",
          wickUpColor: "#61c9b0",
          wickDownColor: "#d67d86",
          borderVisible: false,
        });
        var forecast = chart.addCandlestickSeries({
          upColor: "#a69bff",
          downColor: "#7762b6",
          wickUpColor: "#b9adff",
          wickDownColor: "#a08acf",
          borderColor: "#c7bfff",
          borderVisible: true,
        });
        var volume = chart.addHistogramSeries({
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
        });
        chart.priceScale("volume").applyOptions({
          scaleMargins: { top: 0.85, bottom: 0 },
          visible: false,
        });
        chart
          .priceScale("right")
          .applyOptions({ scaleMargins: { top: 0.1, bottom: 0.22 } });
        scope.$watch("result", function (result) {
          if (!result) return;
          history.setData(result.history);
          forecast.setData(result.forecast);
          forecast.setMarkers([
            {
              time: result.forecast[0].time,
              position: "aboveBar",
              color: "#c7bfff",
              shape: "arrowDown",
              text: "Forecast begins",
            },
          ]);
          volume.setData(
            result.history.concat(result.forecast).map(function (c, i) {
              return {
                time: c.time,
                value: c.volume,
                color: i >= result.history.length ? "#63559570" : "#385e6470",
              };
            }),
          );
          var total = result.history.length + result.forecast.length;
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, total - 100),
            to: total + 4,
          });
        });
        var observer = new ResizeObserver(function () {
          chart.applyOptions({ width: host.clientWidth });
        });
        observer.observe(host);
        scope.$on("$destroy", function () {
          observer.disconnect();
          chart.remove();
        });
      },
    };
  });
