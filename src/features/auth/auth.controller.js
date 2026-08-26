import AuthService from './auth.service.js';
import { ok, created } from '../../utils/respond.js';

/**
 * No branching, no database, no error shaping — the controller translates HTTP
 * to a service call and back. Everything it could decide is decided somewhere
 * that a worker or a test can reach without an HTTP request.
 *
 * Errors are thrown, not caught: the central handler owns the response shape,
 * and a try/catch here would only produce a second, drifting one.
 */
export default class AuthController {
  static async register(req, res) {
    return created(res, await AuthService.register(req.body));
  }

  static async login(req, res) {
    return ok(res, await AuthService.login(req.body));
  }

  static async refresh(req, res) {
    return ok(res, await AuthService.refresh(req.body));
  }

  static async logout(req, res) {
    return ok(res, await AuthService.logout(req.body));
  }

  /** Whoever the token says you are — useful for a client booting up. */
  static async me(req, res) {
    return ok(res, req.user);
  }
}
