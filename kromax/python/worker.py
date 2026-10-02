"""NDJSON protocol: stdout is reserved for messages; library output goes to stderr."""
import contextlib
import json
import sys
import traceback


def emit(message):
    sys.__stdout__.write(json.dumps(message, allow_nan=False) + '\n')
    sys.__stdout__.flush()


def main():
    forecaster = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                if forecaster is None:
                    from forecast import Forecaster
                    forecaster = Forecaster()
                result = forecaster.run(request, lambda message: emit({'id': request['id'], 'type': 'progress', 'message': message}))
            emit({'id': request['id'], 'type': 'result', 'result': result})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            message = str(error) if isinstance(error, ValueError) else f'Forecast failed ({type(error).__name__}). Check server logs, Python dependencies, and model download connectivity.'
            emit({'id': request.get('id'), 'type': 'error', 'message': message})


if __name__ == '__main__':
    main()
