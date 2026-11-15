class base_c;
  function new();
  endfunction
endclass

class kid_c extends base_c;
  function new();
    super.new();
  endfunction
endclass

class quiet_c extends base_c;
  function new();
    // super.new()
    string msg = "super.new()";
  endfunction
endclass
