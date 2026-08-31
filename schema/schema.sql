CREATE TABLE users (
	id SERIAL PRIMARY KEY,
	first_name VARCHAR(300),
	last_name VARCHAR(300),
	email VARCHAR(350) NOT NULL,
	phone VARCHAR(350),
	password_hash VARCHAR(500) NOT NULL,
	profile_image VARCHAR(500),
	is_verified boolean,
	is_admin_user BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP,
	updated_at TIMESTAMP,
	is_deleted boolean
);


-- Roles table
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL
);

-- Role assignments
CREATE TABLE user_roles (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Routes (permissions)
CREATE TABLE routes (
  id SERIAL PRIMARY KEY,
  route VARCHAR(255) UNIQUE NOT NULL
);

-- Role permissions (which roles can access which routes)
CREATE TABLE role_permissions (
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  route_id INT REFERENCES routes(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, route_id)
);

INSERT INTO roles (name) VALUES ('admin');
INSERT INTO roles (name) VALUES ('agent');
